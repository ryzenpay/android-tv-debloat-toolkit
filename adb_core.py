"""All non-UI logic for the Android TV toolkit: ADB discovery, connection state, debloat."""
import http.client
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ADB_TIMEOUT = 15
# A big APK copied over Wi-Fi, and pm install unpacking it afterwards, both run far past ADB_TIMEOUT.
TRANSFER_TIMEOUT = 600
DOWNLOAD_TIMEOUT = 60
MAX_DOWNLOAD_BYTES = 500 * 1024 * 1024
GITHUB_API = "https://api.github.com"


def _find_adb():
    bundled = "adb.exe" if os.name == "nt" else "adb"
    local = os.path.join(SCRIPT_DIR, "adb", bundled)
    if os.path.isfile(local) and os.access(local, os.X_OK):
        return local
    return shutil.which("adb") or "adb"


ADB = _find_adb()


class TVConnection:
    def __init__(self):
        self.connected = False
        self.ip = ""
        self.port = "5555"

    @property
    def target(self):
        return f"{self.ip}:{self.port}"

    def reset(self):
        self.connected = False
        self.ip = ""


state = TVConnection()


def is_valid_ip(ip):
    return bool(re.match(r"^\d{1,3}(\.\d{1,3}){3}$", ip)) and all(
        0 <= int(p) <= 255 for p in ip.split(".")
    )


def run_adb(*args, timeout=None):
    """Run an adb command and return (stdout, stderr, returncode)."""
    try:
        result = subprocess.run(
            [ADB, *args],
            capture_output=True,
            text=True,
            timeout=timeout or ADB_TIMEOUT,
        )
        return result.stdout, result.stderr, result.returncode
    except FileNotFoundError:
        return "", f"adb not found at '{ADB}'. Run 'python setup.py' or install Android platform-tools.", 1
    except OSError as exc:
        return "", (
            f"Cannot run adb at '{ADB}': {exc}. On macOS/Linux install Android platform-tools "
            "(e.g. 'sudo apt install adb') or put a native adb into the adb/ folder."
        ), 1
    except subprocess.TimeoutExpired:
        return "", f"ADB command timed out after {timeout or ADB_TIMEOUT}s.", 1


def device_info(target=None):
    target = target or state.target

    def prop(name):
        stdout, _, rc = run_adb("-s", target, "shell", "getprop", name)
        return stdout.strip() if rc == 0 else ""

    return {
        "model": prop("ro.product.model"),
        "android": prop("ro.build.version.release"),
        "target": target,
    }


# One advertisement per transport, so a single TV publishes several of these at once.
SERVICE_KIND = {
    "_adb._tcp": "plain",
    "_adb-tls-connect._tcp": "tls",
    "_adb-tls-pairing._tcp": "pair",
}


def discover():
    """One row per TV, not one row per advertisement.

    A box publishes ``_adb._tcp`` (the plain port this toolkit connects with), ``_adb-tls-connect._tcp``
    (wireless debugging's own port, reachable only after a pairing code) and, while the pairing screen is
    open on the TV, ``_adb-tls-pairing._tcp`` — which is not connectable at all, it is the port the pairing
    form wants. adb also keeps listing an address it has already attached. Listing every record produced
    three rows for one set-top box: the attached one, the plain one, and the same box on its TLS port.
    """
    attached = {}
    stdout, _, rc = run_adb("devices")
    if rc == 0:
        for line in stdout.replace("\r", "").splitlines()[1:]:
            fields = line.split()
            if len(fields) >= 2 and ":" in fields[0]:
                attached[fields[0]] = fields[1]

    per_host = {}
    for address, status in attached.items():
        per_host.setdefault(address.rsplit(":", 1)[0], {})
    stdout, _, rc = run_adb("mdns", "services")
    if rc == 0:
        for line in stdout.replace("\r", "").splitlines():
            parts = line.split()
            if len(parts) != 3 or ":" not in parts[2]:
                continue
            kind = SERVICE_KIND.get(parts[1])
            if kind:
                per_host.setdefault(parts[2].rsplit(":", 1)[0], {})[kind] = (parts[0], parts[2])

    devices = []
    for host, seen in sorted(per_host.items()):
        plain, tls, pair = seen.get("plain"), seen.get("tls"), seen.get("pair")
        connect = plain or tls
        statuses = [status for address, status in attached.items()
                    if address.rsplit(":", 1)[0] == host]
        address = connect[1] if connect else next(iter(
            sorted(address for address in attached if address.rsplit(":", 1)[0] == host)), host)
        other = [{"address": record[1], "pairable": kind == "tls"}
                 for kind, record in (("plain", plain), ("tls", tls))
                 if record and record[1] != address]
        devices.append({
            "host": host,
            "name": connect[0] if connect else host,
            "address": address,
            "pairable": bool(connect) and connect is tls,
            "status": attached.get(address, "") or (statuses[0] if statuses else ""),
            "pair_port": pair[1] if pair else "",
            "other": other,
        })
    return {"devices": devices}


def transport_state(target=None):
    """What adb reports for a transport: 'device', 'unauthorized', 'offline', or '' when absent.

    'adb connect' exits 0 and prints 'connected' for an unauthorised TV, so the TCP handshake alone
    is not proof the toolkit can run anything — only state 'device' is.
    """
    target = target or state.target
    for line in run_adb("devices")[0].replace("\r", "").splitlines()[1:]:
        fields = line.split()
        if len(fields) >= 2 and fields[0] == target:
            return fields[1]
    return ""


PAIR_HINT = (
    "Android 11+, Google TV and Chromecast builds have no switch named 'ADB Debugging' — it is "
    "Developer options → Wireless debugging. Turn that on, then use 'Pair with a code' below with "
    "the address and 6-digit code from the 'Pair device with pairing code' screen. A TV that has "
    "rebooted or slept also drops its wireless port and needs re-enabling."
)

AUTH_HINT = (
    "The TV only talks to computers it has authorised. Tap 'Always allow from this computer' on the "
    "prompt on the TV screen; if no prompt appeared, the key it saved is gone — use 'Pair with a code' "
    "below with a fresh 6-digit code from the Wireless debugging screen."
)


def connect(ip, port="5555"):
    if not is_valid_ip(ip):
        return {"ok": False, "message": "Invalid IP address. Enter a valid IPv4 address (e.g. 192.168.1.100)."}
    state.ip = ip
    state.port = str(port)
    stdout, stderr, rc = run_adb("connect", state.target)
    if rc == 0 and ("connected" in stdout or "already connected" in stdout):
        transport = transport_state()
        if transport == "device":
            state.connected = True
            return {"ok": True, "message": f"Connected to {state.target}."}
        state.connected = False
        if transport == "unauthorized":
            return {"ok": False, "target": state.target, "transport": transport,
                    "message": f"Reached {state.target}, but the TV has not authorised this computer's key.",
                    "hint": AUTH_HINT}
        return {"ok": False, "target": state.target, "transport": transport,
                "message": f"Reached {state.target}, but the device reports '{transport or 'no state'}'.",
                "hint": PAIR_HINT}
    state.connected = False
    detail = (stderr or stdout).strip() or "No response from adb."
    result = {"ok": False, "message": f"Could not connect to {state.target}. {detail}", "target": state.target}
    lowered = detail.lower()
    if "refused" in lowered or "failed to connect" in lowered or "offline" in lowered or "not found" in lowered:
        result["hint"] = PAIR_HINT
    return result


def pair_and_connect(ip, pair_port, pairing_code, debug_port="5555"):
    if not is_valid_ip(ip):
        return {"ok": False, "message": "Invalid IP address. Enter a valid IPv4 address (e.g. 192.168.1.100)."}
    if not str(pair_port).isdigit() or not str(debug_port).isdigit():
        return {"ok": False, "message": "Ports must be numbers."}
    if not pairing_code:
        return {"ok": False, "message": "Pairing code cannot be empty."}

    stdout, stderr, rc = run_adb("pair", f"{ip}:{pair_port}", str(pairing_code))
    if rc != 0 or ("successfully" not in stdout.lower() and "paired" not in stdout.lower()):
        detail = (stderr or stdout).strip() or "Unknown error"
        return {
            "ok": False,
            "message": f"Pairing failed. {detail} — check the IP, pairing port and code on your TV.",
        }

    result = connect(ip, debug_port)
    if result["ok"]:
        result["message"] = f"Paired and connected to {state.target}."
    else:
        result["message"] = (
            f"Paired, but the connection failed. {result['message']} "
            "Check the debug port shown under 'IP address & Port' on your TV."
        )
    return result


def disconnect():
    target = state.target if state.ip else ""
    if target:
        run_adb("disconnect", target)
    run_adb("disconnect")
    state.reset()
    return {"ok": True, "message": f"Disconnected from {target}." if target else "Disconnected."}


def reconnect_check():
    if not state.connected or not state.ip:
        return False
    if transport_state() == "device":
        return True
    return connect(state.ip, state.port)["ok"]


def _outcome(stdout, stderr, rc):
    combined = f"{stdout}\n{stderr}".lower()
    if rc == 0 and "new state: disabled" in stdout:
        return True, "Disabled"
    if rc == 0 and "success" in combined:
        # pm uninstall, pm clear and cmd package install-existing all answer with just 'Success'.
        return True, ""
    if "already" in combined:
        return True, "Already disabled"
    if "unknown package" in combined:
        return True, "Not installed on this device"
    if rc != 0:
        return False, ((stderr or stdout).strip() or "Unknown error")
    return False, f"Unexpected response — {stdout.strip()}"


ROLE_QUERIES = [
    ("home", "cmd package query-activities -a android.intent.action.MAIN -c android.intent.category.HOME"),
    ("launcher", "cmd package query-activities -a android.intent.action.MAIN -c android.intent.category.LEANBACK_LAUNCHER"),
    ("launcher", "cmd package query-activities -a android.intent.action.MAIN -c android.intent.category.LAUNCHER"),
    ("input", "cmd package query-services -a android.view.InputMethod"),
    ("accessibility", "cmd package query-services -a android.accessibilityservice.AccessibilityService"),
    ("screensaver", "cmd package query-services -a android.service.dreams.DreamService"),
    ("device-admin", "cmd package query-receivers -a android.app.action.DEVICE_ADMIN_ENABLED"),
]
CORE_ROLES = ("home", "input", "accessibility", "device-admin")
_PACKAGE_LINE = re.compile(r"^package:(.+)=(\S+) uid:(\d+)$")


def _shell(cmd, target=None):
    stdout, _, rc = run_adb("-s", target or state.target, "shell", cmd)
    return stdout.replace("\r", "") if rc == 0 else ""


def device_abi(target=None):
    """The instruction set the connected device runs natively ('armeabi-v7a', 'arm64-v8a', …)."""
    return _shell("getprop ro.product.cpu.abi", target).strip()


def _role_packages(query, target):
    out = _shell(f"{query} | grep -o 'packageName=[^ ]*' | sort -u", target)
    return {line.split("=", 1)[1] for line in out.splitlines() if line.startswith("packageName=")}


def _overlay_targets(target=None):
    """{overlay package: package whose resources it rewrites}, straight from the device.

    Overlay ids lie about their target often enough to matter — on this box com.realtek.atv.axel.overlay
    and android.energymode.overlay both rewrite com.android.tv.settings, not what their names say. Only
    currently enabled overlays are listed, so an absent id means no answer, not no overlay.
    """
    targets, current = {}, ""
    for line in _shell("cmd overlay list", target).splitlines():
        line = line.strip()
        if line.startswith("[x] ") and current:
            targets[line[4:]] = current
        elif line and not line.startswith("["):
            current = line.lstrip("-").rstrip(":").strip()
    return targets


def detect_packages(target=None):
    """Everything installed on the device, classified from device facts only.

    Risk is inferred from partition, shared uid, system roles, installer and process
    liveness — never from a package name list. It ranks candidates; it does not
    guarantee safety, so nothing is pre-selected outside the idle system components.
    """
    target = target or state.target
    disabled = {line.split(":", 1)[1] for line in _shell("pm list packages -d --user 0", target).splitlines()
                if line.startswith("package:")}
    third = {line.split(":", 1)[1] for line in _shell("pm list packages -3 -u", target).splitlines()
             if line.startswith("package:")}
    installers = {}
    for line in _shell("pm list packages -i --user 0", target).splitlines():
        # The box separates the two fields with two spaces and prints installer=null when it has none.
        match = re.match(r"^package:(\S+)\s+installer=(\S+)$", line)
        if match and match.group(2) != "null":
            installers[match.group(1)] = match.group(2)
    running = {token for token in _shell("ps -A -o NAME=", target).split() if "." in token}

    roles = {}
    for role, query in ROLE_QUERIES:
        for package in _role_packages(query, target):
            roles.setdefault(package, set()).add(role)
    overlays = _overlay_targets(target)

    detected = []
    for line in _shell("pm list packages -f -U -u --user 0", target).splitlines():
        match = _PACKAGE_LINE.match(line)
        if not match:
            continue
        path, package, uid = match.groups()
        if "/apex/" in path or "framework-res" in path:
            partition = "apex"
        elif path.startswith("/data/app/"):
            partition = "data"
        else:
            partition = path.strip("/").split("/")[0]
        apk = os.path.splitext(path.rsplit("/", 1)[-1])[0]

        reasons = []
        core_roles = sorted(set(roles.get(package, ())) & set(CORE_ROLES))
        if "/overlay/" in path:
            risk = "overlay"
            reason = ("resource overlay — rewrites system resources, not an app" if package not in overlays
                      else f"resource overlay of {overlays[package]} — rewrites that package's resources, not an app")
            reasons.append(reason)
        elif uid in ("1000", "2000"):
            risk = "core"
            reasons.append(f"runs as the {'system' if uid == '1000' else 'adb shell'} uid")
        elif partition in ("apex", "vendor"):
            risk = "core"
            reasons.append(f"{partition} partition")
        elif "/system/framework/" in path:
            risk = "core"
            reasons.append("framework resource")
        elif core_roles:
            risk = "core"
            reasons.extend(f"provides {role}" for role in core_roles)
        elif partition == "data" and package in third:
            risk = "user"
            reasons.append("installed by you")
        elif partition == "data":
            risk = "caution"
            reasons.append("updated from the Play Store" if installers.get(package) == "com.android.vending"
                           else "replaced its system copy")
        elif {"launcher", "home"} & set(roles.get(package, ())):
            risk = "visible"
            reasons.append("has a home-screen entry")
        elif package in running:
            risk = "caution"
            reasons.append("process is running now")
        else:
            risk = "unknown"
            reasons.append("no home-screen entry and no running process, and its purpose is not documented here")

        verdict, note = KNOWN_NOTES.get(package, (None, None))
        label = apk
        detected.append({
            "package": package,
            "label": label,
            "apk": apk,
            "partition": partition,
            "uid": uid,
            "roles": sorted(roles.get(package, ())),
            "installer": installers.get(package, ""),
            "running": package in running,
            "state": "disabled" if package in disabled else "enabled",
            "risk": risk,
            "reasons": reasons,
            "verdict": verdict or "undocumented",
            "note": note or "",
        })
    order = ("bloat", "careful", "undocumented", "keep")
    detected.sort(key=lambda row: (
        order.index(row["verdict"]) if row["verdict"] in order else 9,
        ("unknown", "caution", "visible", "user", "overlay", "core").index(row["risk"]),
        row["package"],
    ))
    return detected


def user_apps(target=None):
    """Packages the device itself counts as installed after the factory image.

    Asked of the device on purpose: uid ranges do not separate user installs from what shipped —
    APEX modules get uids in the same band as apps you installed yourself.
    """
    lines = _shell("pm list packages -3", target).splitlines()
    return sorted(line[len("package:"):] for line in lines if line.startswith("package:"))


def restore(packages, target=None):
    """Re-enable packages disabled earlier — every action here is reversible."""
    target = target or state.target
    results = []
    for package in packages:
        if not isinstance(package, str) or not _PACKAGE.match(package):
            results.append({"package": package, "ok": False, "detail": "Rejected — not a package name"})
            continue
        stdout, stderr, rc = run_adb("-s", target, "shell", "pm", "enable", package)
        combined = f"{stdout}\n{stderr}"
        if rc == 0 and "enabled" in combined.lower():
            detail = "Enabled"
        elif "already" in combined.lower():
            detail = "Already enabled"
        else:
            detail = (stderr or stdout).strip() or "Unknown error"
        results.append({"package": package, "ok": rc == 0, "detail": detail})
    return results


def debloat(packages, target=None, confirm_core=False):
    """Disable packages after checking each one against the device, not a list."""
    target = target or state.target
    detected = {row["package"]: row for row in detect_packages(target)}
    results = []
    for label, package in packages:
        if not isinstance(package, str) or not _PACKAGE.match(package):
            results.append({"label": label, "package": package, "ok": False,
                            "detail": "Rejected — not a package name"})
            continue
        row = detected.get(package)
        if row is None:
            results.append({"label": label, "package": package, "ok": True, "detail": "Not installed on this device"})
            continue
        if row["risk"] in ("core", "overlay") and not confirm_core:
            results.append({"label": label, "package": package, "ok": False,
                            "detail": "Refused — " + ", ".join(row["reasons"])})
            continue
        stdout, stderr, rc = run_adb("-s", target, "shell", "pm", "disable-user", "--user", "0", package)
        ok, detail = _outcome(stdout, stderr, rc)
        results.append({"label": row["label"], "package": package, "ok": ok, "detail": detail})
    return results


def disable_launcher():
    stdout, stderr, rc = run_adb(
        "-s", state.target, "shell", "pm", "disable-user", "--user", "0", "com.google.android.tvlauncher"
    )
    ok, detail = _outcome(stdout, stderr, rc)
    return {"ok": ok, "message": detail or (stdout or stderr or "No output received.").strip()}


def _github_repo(parts):
    """owner/name out of a github.com repo or releases URL, '' when there isn't one."""
    fields = [field for field in parts.path.split("/") if field]
    return "/".join(fields[:2]) if len(fields) >= 2 else ""


# A release can carry one APK per instruction set, plus builds for entirely different hardware.
# Asset naming is each project's own invention, so only the two things that decide whether a file
# can run here are read out of the name: the ABI, and whether it targets another device class.
ABI_RUNTIMES = {
    # A 64-bit box executes 32-bit ARM, never the reverse; same for x86_64 over x86.
    "arm64-v8a": ("arm64-v8a", "armeabi-v7a", "armeabi"),
    "armeabi-v7a": ("armeabi-v7a", "armeabi"),
    "armeabi": ("armeabi",),
    "x86_64": ("x86_64", "x86"),
    "x86": ("x86",),
    "riscv64": ("riscv64",),
}
# Longest first: 'armeabi' is a substring of 'armeabi-v7a' and would shadow it.
ABI_NAMES = ("arm64-v8a", "armeabi-v7a", "armeabi", "riscv64", "x86_64", "x86")
UNIVERSAL_MARKS = ("universal", "noarch", "multi-abi", "all-abi")
# Split on anything that is not a letter or digit, so 'software' is not read as 'wear'.
_NAME_SEGMENTS = re.compile(r"[^a-z0-9]+")
OTHER_DEVICE = {"wear", "automotive"}


def _asset_abi(name):
    for abi in ABI_NAMES:
        if re.search(rf"(?<![A-Za-z0-9]){re.escape(abi)}(?![A-Za-z0-9])", name):
            return abi
    return ""


def _asset_score(name, abi):
    """Higher runs better on this device; negative means the file is not built to run here."""
    low = name.lower()
    if set(_NAME_SEGMENTS.split(low)) & OTHER_DEVICE:
        return -100
    built = _asset_abi(low)
    if not built:
        # Carries every ABI, or names none — either way it installs; prefer the one that says so.
        # A debug build is a developer artifact, but some projects ship nothing else, so it is
        # pushed down rather than ruled out.
        score = 20 if any(mark in low for mark in UNIVERSAL_MARKS) else 10
        return score - 5 if "debug" in _NAME_SEGMENTS.split(low) else score
    if not abi:
        return 15
    if built == abi:
        return 30
    return 25 if built in ABI_RUNTIMES.get(abi, ()) else -100


def github_apk(repo, abi=None):
    """Point 'owner/name' at the APK asset of its newest release that runs on this device.

    GitHub releases carry a lot of non-APK baggage — iSponsorBlockTV, to name one people ask
    about, ships only a Python wheel and standalone server binaries in all 28 of its releases —
    so only assets ending in .apk count, and a release without one reports what it did ship
    rather than letting the download fail on a wheel or a Windows binary. With the device ABI
    passed in, SmartTube's build for a 32-bit box beats its 33 MB universal, and Home Assistant's
    phone build beats the wear and automotive APKs published in the same release.
    """
    request = urllib.request.Request(
        f"{GITHUB_API}/repos/{repo}/releases/latest",
        headers={"User-Agent": "android-tv-toolkit", "Accept": "application/vnd.github+json"})
    try:
        with urllib.request.urlopen(request, timeout=DOWNLOAD_TIMEOUT) as served:
            release = json.loads(served.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            return {"ok": False, "message": f"{repo} has no published release to install from."}
        if exc.code in (403, 429):
            return {"ok": False, "message": f"GitHub would not answer for {repo} — the anonymous API allows "
                                            "60 lookups an hour per address. Paste the APK link directly instead."}
        return {"ok": False, "message": f"GitHub returned HTTP {exc.code} for {repo}."}
    except (urllib.error.URLError, OSError, ValueError) as exc:
        return {"ok": False, "message": f"Could not ask GitHub about {repo}: {exc}"}

    assets = release.get("assets") or []
    apk = [a for a in assets if str(a.get("name", "")).lower().endswith(".apk")]
    tag = release.get("tag_name") or "latest"
    if not apk:
        shipped = ", ".join(sorted({os.path.splitext(str(a.get("name", "")))[1].lstrip(".") or "binaries"
                                    for a in assets})) or "no files"
        return {"ok": False, "message": f"{repo} {tag} publishes no APK — it ships {shipped}. "
                                        "There is nothing here for the TV to install."}
    abi = (abi or "").strip()
    # Ties go to the smaller download — 'app-full-release' over 'app-minimal-release' has to be
    # settled by something, and every other qualifier would need its own rule.
    best = max(apk, key=lambda a: (_asset_score(str(a.get("name", "")), abi), -(a.get("size") or 0)))
    if _asset_score(str(best.get("name", "")), abi) < 0:
        return {"ok": False, "message": f"{repo} {tag} ships no APK built to run on this device"
                                        f"{f' ({abi})' if abi else ''} — its APKs are "
                                        f"{', '.join(str(a.get('name')) for a in apk)}. "
                                        "Paste a direct APK link if you know one that fits."}
    return {"ok": True, "url": best["browser_download_url"], "name": best["name"], "tag": tag}


def download_apk(url, abi=None):
    """Fetch an APK into a temp file and return {'ok', 'path', 'name', 'bytes'}; the caller deletes the path."""
    url = str(url or "").strip()
    parts = urllib.parse.urlsplit(url)
    if parts.scheme.lower() not in ("http", "https"):
        return {"ok": False, "message": f"Only http and https URLs can be installed, not "
                                        f"'{parts.scheme or '(none)'}'. Paste a direct link to the APK."}
    if not parts.netloc:
        return {"ok": False, "message": f"'{url}' has no host in it. Paste a full link such as "
                                        "https://example.com/app.apk."}
    name = os.path.basename(urllib.parse.unquote(parts.path)).strip() or "app.apk"
    # A GitHub project page is a link to releases, not a link to a file — resolve it first.
    if parts.netloc.lower() in ("github.com", "www.github.com"):
        repo = _github_repo(parts)
        if not repo:
            return {"ok": False, "message": "That GitHub link has no owner/name in it. Use a link such as "
                                            "https://github.com/owner/name."}
        found = github_apk(repo, abi)
        if not found["ok"]:
            return found
        url, name, parts = found["url"], found["name"], urllib.parse.urlsplit(found["url"])

    handle, path = tempfile.mkstemp(suffix=".apk")
    os.close(handle)
    ok, size, ctype = False, 0, ""
    try:
        with open(path, "wb") as sink, urllib.request.urlopen(url, timeout=DOWNLOAD_TIMEOUT) as served:
            ctype = (served.headers.get("Content-Type") or "").strip()
            declared = (served.headers.get("Content-Length") or "").strip()
            if declared.isdigit() and int(declared) > MAX_DOWNLOAD_BYTES:
                return {"ok": False, "message": f"That file is {int(declared) / 1048576:.1f} MB, over the "
                                                f"{MAX_DOWNLOAD_BYTES // 1048576} MB limit."}
            while True:
                chunk = served.read(1048576)
                if not chunk:
                    break
                size += len(chunk)
                if size > MAX_DOWNLOAD_BYTES:
                    return {"ok": False, "message": f"Aborted: the download ran past the "
                                                    f"{MAX_DOWNLOAD_BYTES // 1048576} MB limit."}
                sink.write(chunk)
        with open(path, "rb") as head:
            magic = head.read(2)
        if magic != b"PK":
            return {"ok": False, "message": f"That URL did not serve an APK"
                                            f"{f' — it served {ctype}' if ctype else ''}. "
                                            "An APK is a .zip file, so paste a link to one."}
        ok = True
        return {"ok": True, "path": path, "name": name, "bytes": size}
    except urllib.error.HTTPError as exc:
        return {"ok": False, "message": f"HTTP {exc.code} {exc.reason} from {parts.netloc}."}
    except urllib.error.URLError as exc:
        return {"ok": False, "message": f"Could not reach {parts.netloc}: {exc.reason}."}
    except (http.client.HTTPException, OSError, ValueError) as exc:
        return {"ok": False, "message": f"Download from {parts.netloc} failed: {exc}."}
    finally:
        if not ok:
            try:
                os.remove(path)
            except OSError:
                pass


def _first_error(*outputs):
    """The one line from a pm failure worth showing; the rest is a Java stack trace.

    pm prints a bare header ("Exception occurred while executing 'install':") above the reason, so the
    header only wins when nothing more specific is in the output — otherwise the real cause, which is
    usually a java.lang.* line, is what the user should read.
    """
    detail = "\n".join(out.strip() for out in outputs if out and out.strip())
    lines = [line for line in detail.splitlines() if line.strip()]
    for line in lines:
        if line.startswith(("Error:", "Failure:", "INSTALL")):
            return line
    for line in lines:
        if "Error:" in line or "Failure:" in line:
            return line
    return lines[0] if lines else "unknown error"


def install_apk(local_path, remote_name=None):
    # The basename of a local temp file is random, so the caller can name what actually lands on the device.
    name = os.path.basename(str(remote_name or local_path))
    # /data/local/tmp, never /sdcard: pm install is a read by system_server, which on Android 11+ is
    # denied the fuse context and answers with SELinux denials plus a stack trace instead of an APK.
    remote = f"/data/local/tmp/{name}"
    push_out, push_err, push_rc = run_adb("-s", state.target, "push", local_path, remote,
                                          timeout=TRANSFER_TIMEOUT)
    if push_rc != 0:
        return {"ok": False, "message": f"Push failed: {(push_err or push_out).strip()}"}
    install_out, install_err, install_rc = run_adb("-s", state.target, "shell", "pm", "install", "-r", remote,
                                                   timeout=TRANSFER_TIMEOUT)
    run_adb("-s", state.target, "shell", "rm", "-f", remote)
    ok = install_rc == 0 and "success" in (install_out or "").lower()
    return {"ok": ok, "message": f"Installed {name}." if ok else f"Install failed: {_first_error(install_err, install_out)}"}


KEYS = {
    "back": 4, "home": 3, "recents": 187, "ok": 23, "menu": 82, "info": 164,
    "up": 19, "down": 20, "left": 21, "right": 22,
    "vol_up": 24, "vol_down": 25, "mute": 91,
    "play": 126, "pause": 127, "play_pause": 85,
    "rewind": 168, "forward": 167,
    "channel_up": 166, "channel_down": 165, "guide": 172,
    "settings": 176, "tv_input": 178, "hdmi_1": 243, "power": 26,
}

# Only these settings are writable, and each has a factory value so it can be put back.
TUNABLES = {
    "window_animation_scale": ("global", "1.0"),
    "transition_animation_scale": ("global", "1.0"),
    "animator_duration_scale": ("global", "1.0"),
    "font_scale": ("system", "1.0"),
    "stay_on_while_plugged_in": ("global", "0"),
}

_NUMBER = re.compile(r"^\d+(\.\d+)?$")
# 'adb shell a b c' joins its arguments into one string for /system/bin/sh on the TV, so a value
# reaching one of these must carry no shell syntax at all — argv separation buys nothing here.
_PACKAGE = re.compile(r"^[A-Za-z0-9_.]{1,128}$")
_COMPONENT = re.compile(r"^[A-Za-z0-9_.]{1,128}/[A-Za-z0-9_.]{1,128}$")

_TELEMETRY = "; ".join([
    'echo "@up $(cut -d. -f1 /proc/uptime)"',
    'echo "@mem_total $(grep -m1 MemTotal /proc/meminfo | awk \'{print $2}\')"',
    'echo "@mem_avail $(grep -m1 MemAvailable /proc/meminfo | awk \'{print $2}\')"',
    'echo "@load $(cut -d\' \' -f1-3 /proc/loadavg)"',
    'echo "@disk $(df -k /data | tail -1 | awk \'{print $2" "$3" "$4" "$5}\')"',
    'echo "@size $(wm size | tr \'\\n\' \' \')"',
    'echo "@density $(wm density | head -1)"',
    'echo "@ip $(ip -4 addr show scope global | grep -m1 -o \'inet [0-9.]*\' | cut -d\' \' -f2)"',
    'echo "@home $(cmd role get-role-holders android.app.role.HOME 0 | tr -d \'\\r\')"',
    'echo "@user $(pm list users | grep -m1 -o \'UserInfo{[^}]*}\')"',
])


def _kv(text):
    values = {}
    for line in text.splitlines():
        if line.startswith("@") and " " in line:
            key, value = line[1:].split(" ", 1)
            values[key] = value.strip()
    return values


def telemetry(target=None):
    """One round trip: identity, uptime, memory, storage, display, network, launcher."""
    target = target or state.target
    raw = _kv(_shell(_TELEMETRY, target))
    props = {}
    for key, prop in (("serial", "ro.serialno"), ("build", "ro.build.display.id"),
                      ("abi", "ro.product.cpu.abi"), ("sdk", "ro.build.version.sdk"),
                      ("manufacturer", "ro.product.manufacturer"), ("type", "ro.build.type")):
        props[key] = _shell(f"getprop {prop}", target).strip()

    disk = raw.get("disk", "").split()
    storage = {}
    if len(disk) == 4:
        total, used, free, percent = disk
        storage = {"total_mb": int(total) // 1024, "used_mb": int(used) // 1024,
                   "free_mb": int(free) // 1024, "percent": percent}

    sizes = [part for part in raw.get("size", "").split() if "x" in part]
    return {
        "serial": props.get("serial"), "build": props.get("build"), "abi": props.get("abi"),
        "sdk": props.get("sdk"), "manufacturer": props.get("manufacturer"), "build_type": props.get("type"),
        "uptime_hours": round(int(raw.get("up", "0") or 0) / 3600, 1),
        "memory_mb": int(raw.get("mem_total", "0") or 0) // 1024,
        "memory_free_mb": int(raw.get("mem_avail", "0") or 0) // 1024,
        "load": raw.get("load", ""),
        "storage": storage,
        "resolution": sizes[-1] if sizes else "",
        "physical_resolution": sizes[0] if sizes else "",
        "density": raw.get("density", "").replace("Physical density: ", "").strip(),
        "ip": raw.get("ip", ""),
        "launcher": raw.get("home", ""),
        "user": raw.get("user", ""),
    }


def screenshot(target=None):
    """PNG bytes of the current screen. exec-out, so the binary is not newline-translated."""
    try:
        result = subprocess.run(
            [ADB, "-s", target or state.target, "exec-out", "screencap", "-p"],
            capture_output=True, timeout=ADB_TIMEOUT + 10,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return None, f"Screenshot failed: {exc}"
    if result.returncode != 0 or not result.stdout.startswith(b"\x89PNG"):
        detail = result.stderr.decode("utf-8", "replace").strip() or "the device returned no image"
        return None, f"Screenshot failed: {detail}"
    return result.stdout, ""


def send_key(key, target=None):
    code = KEYS.get(str(key).strip().lower())
    if code is None:
        return {"ok": False, "message": f"Unknown key '{key}'. Known: {', '.join(sorted(KEYS))}."}
    stdout, stderr, rc = run_adb("-s", target or state.target, "shell", "input", "keyevent", str(code))
    ok = rc == 0
    return {"ok": ok, "message": f"Sent {key}." if ok else (stderr or stdout or "input failed").strip()}


def read_log(lines=200, target=None):
    count = max(10, min(int(lines or 200), 2000))
    return [line for line in _shell(f"logcat -d -t {count}", target).splitlines() if line.strip()]


def app_details(package, target=None):
    """Version, install source, sizes and permissions for one package."""
    if not _PACKAGE.match(package or ""):
        return {"ok": False, "message": "Invalid package name."}
    target = target or state.target
    info = {}
    listing = _shell(f"dumpsys package {package} | grep -E "
                     f"'versionCode=|versionName=|installerPackageName|firstInstallTime"
                     f"|lastUpdateTime|primaryCpuAbi' | head -8", target)
    for line in listing.splitlines():
        for field in ("versionName", "installerPackageName", "firstInstallTime",
                      "lastUpdateTime", "primaryCpuAbi"):
            if field + "=" in line:
                info.setdefault(field, line.split(field + "=", 1)[1].strip())
        if "versionCode=" in line:
            head = line.split("versionCode=", 1)[1].split()
            info.setdefault("versionCode", head[0])
            for part in head[1:]:
                if part.startswith(("minSdk=", "targetSdk=")):
                    key, _, value = part.partition("=")
                    info.setdefault(key, value)
    apk_kb = 0
    for line in _shell(f"pm path {package}", target).splitlines():
        if line.startswith("package:"):
            size = _shell(f"du -k {line[8:]}", target).split()
            if size and size[0].isdigit():
                apk_kb += int(size[0])
    data = _shell(f"du -sk /data/data/{package} 2>/dev/null", target).split()
    return {
        "ok": True, "package": package, "info": info,
        "apk_kb": apk_kb,
        "data_kb": int(data[0]) if data and data[0].isdigit() else None,
        "permissions": [line.strip() for line in _shell(
            f"dumpsys package {package} | sed -n '/runtime permissions:/,$p' | grep -m 40 'granted='",
            target).splitlines() if "granted=" in line],
    }


APP_ACTIONS = {
    "force-stop": "am force-stop {pkg}",
    "clear-data": "pm clear {pkg}",
    "launch": "monkey -p {pkg} -c android.intent.category.LAUNCHER 1",
    "uninstall-updates": "pm uninstall-updates {pkg}",
    "uninstall": "pm uninstall {pkg}",
    "uninstall-user": "pm uninstall -k --user 0 {pkg}",
    "reinstall-keep-data": "cmd package install-existing --user 0 {pkg}",
}
CONFIRM_ACTIONS = {"clear-data", "uninstall-updates", "uninstall", "uninstall-user"}


def app_action(package, action, target=None, confirm=False):
    if action not in APP_ACTIONS:
        return {"ok": False, "message": f"Unknown action '{action}'. Known: {', '.join(sorted(APP_ACTIONS))}."}
    if not _PACKAGE.match(package or ""):
        return {"ok": False, "message": "Invalid package name."}
    if action in CONFIRM_ACTIONS and not confirm:
        return {"ok": False, "message": f"'{action}' needs confirm=true."}
    target = target or state.target
    if not _shell(f"pm path {package}", target).strip():
        return {"ok": False, "message": f"{package} is not installed on this device."}
    stdout, stderr, rc = run_adb("-s", target, "shell", APP_ACTIONS[action].format(pkg=package))
    ok, detail = _outcome(stdout, stderr, rc)
    output = (stdout or "") + (stderr or "")
    if not ok and "installed for user: 0" in output:
        # install-existing on a package the user already has is a no-op, not a failure.
        ok, detail = True, f"{package} is already installed for user 0."
    if not ok and "delete_failed" in output.lower():
        # Every system app answers a real uninstall this way; the per-user one is the route that works.
        ok = False
        detail = ("System app — the partition holds it, so a full uninstall is refused. "
                  "Use Uninstall for user 0 (Re-enable for user 0 puts it back) or Disable instead.")
    if ok and action == "uninstall-user":
        detail = f"Removed {package} for user 0. Re-enable for user 0 puts it back."
    return {"ok": ok, "message": detail or f"{action} applied to {package}."}


def launcher_options(target=None):
    """HOME-capable activities the device will accept as a launcher, plus the current holder."""
    target = target or state.target
    options = []
    for line in _shell(
        "cmd package query-activities -a android.intent.action.MAIN "
        "-c android.intent.category.HOME --brief", target).splitlines():
        line = line.strip()
        if "/" in line and " " not in line:
            options.append({"component": line, "package": line.split("/", 1)[0]})
    current = _shell("cmd role get-role-holders android.app.role.HOME 0", target).strip().splitlines()
    return {"current": current[0] if current else "", "options": options}


def set_launcher(component, target=None):
    component = (component or "").strip()
    if not _COMPONENT.match(component):
        return {"ok": False, "message": "Invalid component name."}
    target = target or state.target
    # set-home-activity is handed to the TV as one interpolated string, so the regex alone is not
    # the gate: the component also has to be one the device itself reported as HOME-capable.
    offered = {row["component"] for row in launcher_options(target)["options"]}
    if component not in offered:
        return {"ok": False, "message": f"{component} is not a launcher this device offers — pick one from the list."}
    stdout, stderr, rc = run_adb("-s", target, "shell", f"cmd package set-home-activity {component}")
    ok = rc == 0
    return {"ok": ok, "message": f"Default launcher set to {component}." if ok
            else (stderr or stdout or "set-home-activity failed").strip()}


def tunable_values(target=None):
    command = "; ".join(f'echo "@{name} $(settings get {table} {name})"'
                        for name, (table, _) in TUNABLES.items())
    current = _kv(_shell(command, target))
    return {
        "values": {name: {"value": current.get(name) or "null", "factory": default}
                   for name, (_, default) in TUNABLES.items()}
    }


def set_tunable(name, value, target=None):
    spec = TUNABLES.get(name)
    if not spec:
        return {"ok": False, "message": f"'{name}' is not adjustable here."}
    table, _default = spec
    value = str(value).strip()
    if not _NUMBER.match(value):
        return {"ok": False, "message": "Value must be a number."}
    stdout, stderr, rc = run_adb("-s", target or state.target, "shell", "settings", "put", table, name, value)
    ok = rc == 0
    return {"ok": ok, "message": f"{name} = {value}" if ok else (stderr or "settings put failed").strip()}


def reboot(target=None):
    stdout, stderr, rc = run_adb("-s", target or state.target, "reboot")
    ok = rc == 0
    return {"ok": ok, "message": "Rebooting — ADB drops for a minute and Wireless debugging may need "
                                 "re-enabling on the TV." if ok else (stderr or stdout or "reboot failed").strip()}


# What a package is *for*, where that is known. Advisory only: presence, state and
# role always come from the device. Anything absent here is reported as undocumented
# rather than guessed safe, because "no launcher entry and no running process" also
# describes com.android.shell, the network stack and Google Services Framework.
KNOWN_NOTES = {
    "com.google.android.backdrop": ("bloat", "Ambient/backdrop artwork and photos shown over the home screen."),
    "com.google.android.apps.tv.dreamx": ("bloat", "Ambient-mode screensaver content and its ads."),
    "com.android.dreams.basic": ("bloat", "Stock clocks and screensavers."),
    "android.autoinstalls.config.BRAND_NAME": ("bloat", "Play Store auto-install config — lets Google push apps onto the box."),
    "com.google.android.feedback": ("bloat", "Sends usage crash/feedback reports."),
    "com.google.android.partnersetup": ("bloat", "Pushes partner/bookmark configuration to the device."),
    "com.google.android.onetimeinitializer": ("bloat", "Runs once at first boot to seed other apps."),
    "com.google.android.syncadapters.calendar": ("bloat", "Calendar sync; nothing on a TV schedules calendar."),
    "com.android.providers.calendar": ("bloat", "Calendar database, only useful with a calendar app."),
    "com.android.providers.contacts": ("bloat", "Contacts database, unused on a TV."),
    "com.android.providers.userdictionary": ("bloat", "Keyboard user dictionary."),
    "com.google.android.marvin.talkback": ("bloat", "VoiceOver-style screen reader for accessibility."),
    "com.google.android.apps.mediashell": ("bloat", "DIAL/Cast receiver daemon (only if you never cast *to* this box)."),
    "com.google.android.play.games": ("bloat", "Play Games services."),
    "com.android.tv.settings": ("keep", "The TV's own Settings app."),
    "com.google.android.gsf": ("keep", "Google Services Framework — sign-in and Play registration depend on it."),
    "com.google.android.gms": ("keep", "Play Services — almost every streaming app depends on it."),
    "com.android.vending": ("keep", "Play Store."),
    "com.google.android.packageinstaller": ("keep", "Installs APKs; disabling it breaks installs."),
    "com.android.shell": ("keep", "adb shell runs under this package — disabling it kills ADB access."),
    "com.android.networkstack": ("keep", "Wi-Fi/networking depends on it."),
    "com.android.providers.tv": ("keep", "TvProvider holds channel/input data."),
    "com.google.android.katniss": ("careful", "Google voice search / Assistant for TV."),
    "com.google.android.tungsten.setupwraith": ("careful", "Out-of-box setup wizard; disabling after first boot is usually fine."),

    # Telemetry, ads, consent and uploaders — all four verdicts came from more than one public
    # debloat list or an applied ADB session on a real Google TV image, never from the name.
    "com.android.adservices.api": ("bloat", "Android 14 Privacy Sandbox ad APIs; nothing you watch depends on them."),
    "com.android.ondevicepersonalization.services": ("bloat", "On-device personalization service feeding Google's content/ad models."),
    "com.android.federatedcompute.services": ("bloat", "Federated-compute worker that trains Google's models on this device."),
    "com.android.tv.feedbackconsent": ("bloat", "Shows and stores the 'help improve Google TV' consent dialog."),
    "com.android.backupconfirm": ("bloat", "The 'back up your data' confirmation dialog."),
    "com.android.sharedstoragebackup": ("bloat", "Shared-storage backup stub."),
    "com.android.wallpaperbackup": ("bloat", "Backs wallpapers to the cloud; a TV has no wallpaper picker."),
    "com.android.dynsystem": ("bloat", "Dynamic system-partition installer, dead weight on a locked box."),
    "com.android.htmlviewer": ("bloat", "Opens raw HTML files pulled off USB storage."),
    "com.android.printspooler": ("bloat", "Print spooler; there is no printer stack on a TV."),
    "com.android.emergency": ("bloat", "Emergency-info/dialing stub with nothing to dial from a TV."),
    "com.google.android.youtube.tvmusic": ("bloat", "YouTube Music for TV."),

    # Google TV platform pieces. The two that people lose the most often are the launcher and the
    # remote service, which is why they are careful/keep despite looking like killable bloat.
    "com.google.android.apps.tv.launcherx": ("careful", "The Google TV home screen itself; the Home key has nowhere to go without it."),
    "com.google.android.tv.remote.service": ("keep", "Phone-as-remote and remote pairing service — looks like bloat, is not."),
    "com.google.android.tv.frameworkpackagestubs": ("careful", "Stubs GMS routes framework intents through; breaks sign-in UI on some builds."),
    "com.android.tv.frameworkpackagestubs": ("careful", "Stubs GMS routes framework intents through; breaks sign-in UI on some builds."),
    "com.android.statementservice": ("careful", "App-link verification; disabling breaks deep links into apps."),
    "com.android.hotspot2.osulogin": ("careful", "Passpoint/Hotspot 2.0 sign-in for managed Wi-Fi."),
    "com.android.nearby.halfsheet": ("careful", "Nearby Share half-sheet — phones stop offering to hand content to the TV."),
    "com.google.android.safetycenter.resources": ("keep", "Overlay of Safety Center resources (app security warnings)."),
    "com.google.android.overlay.googlewebview": ("keep", "Overlay pointing WebView intents at Google's WebView implementation."),
    "com.android.tv.globalkeyhandler": ("careful", "Handles the GLOBAL_BUTTON broadcasts behind the remote's customisable keys."),

    # GMS glue: mostly small updatable components whose absence shows up as a broken sign-in, not
    # as a missing app. The .overlay.modules.* rows are the framework's pointers at GMS defaults.
    "com.google.android.ext.services": ("keep", "Android extension services that GMS components lean on."),
    "com.google.android.ext.shared": ("keep", "Shared library that GMS components link against."),
    "com.google.android.modulemetadata": ("keep", "Declares GMS updatable-module metadata to the framework."),
    "com.google.android.overlay.modules.ext.services": ("bloat", "Overlay redirecting extension-service config; disabling only rewires defaults."),
    "com.google.android.overlay.modules.permissioncontroller": ("keep", "Overlay pointing the framework at Google's permission UI."),
    "com.google.android.overlay.modules.permissioncontroller.forframework": ("keep", "Same permission-UI overlay, applied to the framework package."),
    "com.google.android.overlay.modules.modulemetadata.forframework": ("keep", "Overlay declaring updatable-module metadata to the framework."),
    "com.google.android.permissioncontroller": ("keep", "Runtime permission dialogs."),
    "com.google.android.webview": ("keep", "Chrome WebView back-end for in-app web pages; GMS updatable."),
    "com.google.android.inputmethod.latin": ("keep", "On-screen keyboard; without it you cannot type a Wi-Fi password."),
    "com.google.android.tts": ("careful", "Speech engine for Assistant and TalkBack; losing it silences voice replies."),
    "com.google.android.youtube.tv": ("careful", "YouTube for TV; the remote's dedicated YouTube key stops working."),

    # Framework pieces whose role is settled by what they provide. location.fused is keep against
    # two independent reports of a boot loop after it was disabled — that is the note that matters.
    "com.android.location.fused": ("keep", "Fused location provider — two sources report a boot loop after disabling it."),
    "com.android.systemui": ("keep", "Volume overlay, system dialogs, picture-in-picture."),
    "com.android.bluetooth": ("keep", "Bluetooth stack; the remote pairs over BLE."),
    "com.android.providers.settings": ("keep", "The Settings database itself."),
    "com.android.providers.media.module": ("keep", "Updatable MediaProvider; USB storage reads fail without it."),
    "com.android.providers.media": ("keep", "MediaProvider (legacy id); older builds resolve media through it."),
    "com.android.providers.downloads": ("keep", "Download manager used by in-app downloads."),
    "com.android.externalstorage": ("keep", "Handles USB storage mounts."),
    "com.android.inputdevices": ("keep", "Input-device configuration; the remote is an input device."),
    "com.android.keychain": ("keep", "System keystore access prompts."),
    "com.android.certinstaller": ("keep", "Installs CA certificates — needed for proxy debugging."),
    "com.android.captiveportallogin": ("keep", "Captive-portal sign-in page for hotel and public Wi-Fi."),
    "com.android.companiondevicemanager": ("keep", "Companion-device pairing API used by watch and wearable apps."),
    "com.android.networkstack.tethering": ("keep", "Tethering/hotspot half of the network stack."),
    "com.android.settings.intelligence": ("keep", "Search inside Settings."),
    "com.android.intentresolver": ("keep", "Resolves intents and direct-share targets; part of the share sheet."),
    "com.android.localtransport": ("keep", "Local transport for debug/logging."),
    "com.android.proxyhandler": ("keep", "Handles system proxy settings."),
    "com.android.pacprocessor": ("keep", "Proxy auto-config processor — a manual proxy setup stops resolving."),
    "com.android.se": ("keep", "Secure Element service; the NFC payment stack breaks without it."),
    "com.android.uwb.resources": ("keep", "Overlay of framework resources for Ultra Wideband."),
    "com.android.connectivity.resources": ("keep", "Overlay of framework resources for connectivity."),
    "com.android.wifi.resources": ("keep", "Overlay of framework resources for Wi-Fi."),
    "com.android.wifi.dialog": ("keep", "Wi-Fi permission and connection dialogs."),
    "com.android.vpndialogs": ("keep", "The 'VPN will monitor your traffic' prompt; without it VPNs cannot connect."),
    "com.android.managedprovisioning": ("keep", "Work-profile / device-admin provisioning flow."),
    "com.android.sdksandbox": ("keep", "Sandbox for SDK feature modules and instant apps."),
    "com.android.cameraextensions": ("keep", "Camera extensions HAL glue."),
    "com.android.healthconnect.backuprestore": ("keep", "Health Connect backup/restore component."),
    "com.android.health.connect.backuprestore": ("keep", "Health Connect backup/restore component (id used on this build)."),
    "com.android.healthconnect.controller": ("keep", "Health Connect — privacy dashboard for health-data apps."),
    "com.android.devicelockcontroller": ("keep", "Device lock/management controller (device policy)."),
    "com.android.rkpdapp": ("keep", "Remote Key Provisioning service — the framework asks it for device-backed keys."),
    "com.android.dreams.phototable": ("bloat", "AOSP Photo Table screensaver — replaces only the dream you already have."),
    "com.android.cts.ctsshim": ("bloat", "CTS compatibility-test shim left in the system image."),
    "com.android.cts.priv.ctsshim": ("bloat", "Privileged CTS compatibility-test shim."),
    "com.android.virtualmachine.res": ("bloat", "Placeholder resources for the VM feature; no VM runs on a TV."),

    # Resource overlays carry no code: they rewrite another package's resources, and the id often
    # names something other than the package it rewrites — so the target is read off the device
    # (`cmd overlay list`) and shown with the row, not asserted here. What is left in these notes is
    # only what the device cannot say. A wrong guess is how HDMI inputs and Wi-Fi get lost, so none
    # of them claims a behavioural effect.
    "android.overlay.common": ("careful", "Common framework resource overlay."),
    "android.energymode.overlay": ("careful", "Rewrites TV Settings energy-mode options; framework-res is not the target."),
    "android.tvsettings.sdmc.overlay": ("careful", "TV Settings brand resoverlay (device manufacturer config)."),
    "com.android.providers.settings.overlay.common": ("careful", "Overlay on the Settings provider resources."),
    "com.android.tv.overlay.framework": ("careful", "Framework resource overlay for TV behaviour."),
    "com.android.tv.overlay.framework.globalkeysoverlay": ("careful", "Framework overlay mapping TV global keys."),
    "com.android.tv.overlay.networkstack": ("careful", "Network-stack resource overlay for TV."),
    "com.android.tv.overlay.settingsprovider": ("careful", "TvProvider/settings-provider resource overlay."),
    "com.android.tv.overlay.wifi.resources": ("careful", "Wi-Fi resource overlay in the TV overlay set."),
    "com.android.tv.settings.overlay": ("careful", "Installed but not enabled in the device's overlay list — inert as it stands."),
    "com.android.tv.settings.gms.resoverlay": ("careful", "Google Mobile Services resoverlay for TV Settings."),
    "com.android.tv.settings.google.resoverlay": ("careful", "Google-specific resoverlay for TV Settings."),
    "com.android.tv.settings.rtk.resoverlay": ("careful", "Realtek vendor resoverlay for TV Settings."),
    "com.android.tv.settings.vendor.resoverlay": ("careful", "Board vendor resoverlay for TV Settings."),
    "com.google.android.tv.settings.energymodes.resoverlay": ("careful", "Google TV Settings energy-modes resoverlay."),
    "com.google.android.overlay.gtvsconfigx": ("careful", "Google TV SConfigX overlay — system configuration values."),
    "com.google.android.overlay.gtvssettingsprovider": ("careful", "Google TV settings-provider overlay (TvProvider config)."),
    "com.realtek.gsi.tethering.overlay": ("careful", "Overlay on the tethering network stack's resources."),
    "com.realtek.tethering.overlay": ("careful", "Installed but not enabled in the device's overlay list — inert as it stands."),
    "com.realtek.ui_1080.frameworkoverlay": ("careful", "Framework overlay carrying Realtek's 1080 UI config."),
    "com.realtek.wifi.resources.overlay": ("careful", "Realtek Wi-Fi resource overlay."),
    "com.realtek.atv.axel.overlay": ("careful", "Rewrites TV Settings resources; the axel in its name is not the target."),
    "com.realtek.slices": ("careful", "Settings-Slices provider behind TV Settings pages (video, screensaver, hotspot, advanced)."),
    "com.realtek.slices.ext": ("careful", "Settings-Slices extension carrying the CEC options page."),
    "com.realtek.slices.tv.resoverlay": ("careful", "Overlay on the TV Settings slice provider."),
    "com.droidlogic.overlay": ("careful", "Vendor framework resource overlay."),
    "com.onn.slices.res.overlay": ("careful", "Brand overlay on the TV Settings slice provider."),
    "com.onn.slices.ext.res.overlay": ("careful", "Brand overlay on the slice provider's CEC extension."),
    "com.onn.btpairoverlay": ("careful", "Brand overlay on the Bluetooth remote setup wizard."),
    "com.droidlogic.launcher.provider.overlay": ("careful", "Overlay on the vendor launcher's channel provider resources."),

    # Vendor services read off this device itself (pm list features, cmd overlay list, dumpsys
    # package). Anything the device did not answer for is absent rather than guessed.
    "com.dolby.android.audio.service": ("keep", "Dolby audio service on the output path."),
    "com.droidlogic.launcher.provider": ("keep", "TvProvider for the vendor launcher — channel and input data."),
    "com.google.android.tv.axel": ("keep", "AtvAxel — the IR-blaster/Magic remote setup wizard and remote config receivers."),
    "com.realtek.android.tv.googletvconnecteddevices": ("careful", "Connected-devices screen and Bluetooth device profile services."),
    "com.onn.bluetoothconnect": ("careful", "BtRemoteSetupWizard — Bluetooth remote setup hooked into the first-boot wizard."),
    "com.onn.updatenotification": ("bloat", "UpdateNotification — persistent boot receiver that posts the system-update nag."),
    "com.gretzky.GlobalKey": ("careful", "Vendor GlobalReceiver for GLOBAL_BUTTON broadcasts; which keys, undocumented."),
    "com.smartdevice.tv.aircast": ("bloat", "Casting receiver installed from Play (version name ends -airplay); no system role."),
    "rtk.axel.overlay": ("careful", "AXEL app-framework overlay — app layer config."),
    "com.sdapp.axeloverlay": ("careful", "AXEL app-layer overlay (app recommendations/connections)."),
    "com.google.android.tv.dfuservice": ("careful", "Persistent Google TV system app sharing GMS's signature; 'DFU' is its name, not a proven function."),

    # Sideloaded by the owner, classified by the installer the device reports rather than by name —
    # Play-installed copies are refused because a disabled store app outranks the user's choice.
    "com.netflix.ninja": ("keep", "Netflix for TV, installed from Play; sideloading or disabling it breaks the remote's Netflix key."),
    "com.netflix.tokenmanager": ("keep", "Netflix device-token helper installed alongside Netflix; disabling it signs the box out."),
    "com.amazon.amazonvideo.livingroom": ("careful", "Prime Video for TV; a Play-installed copy is refused, sideloaded is yours to remove."),
}
