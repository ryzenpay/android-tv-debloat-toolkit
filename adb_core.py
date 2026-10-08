"""All non-UI logic for the Android TV toolkit: ADB discovery, connection state, debloat."""
import json
import os
import re
import shutil
import subprocess
import sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.environ.get("TOOLKIT_CONFIG") or os.path.join(SCRIPT_DIR, "config.json")
ADB_TIMEOUT = 15


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


def run_adb(*args):
    """Run an adb command and return (stdout, stderr, returncode)."""
    try:
        result = subprocess.run(
            [ADB, *args],
            capture_output=True,
            text=True,
            timeout=ADB_TIMEOUT,
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
        return "", "ADB command timed out.", 1


def load_config():
    try:
        with open(CONFIG_PATH, encoding="utf-8") as handle:
            data = json.load(handle)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def save_config(**values):
    merged = {**load_config(), **values}
    try:
        with open(CONFIG_PATH, "w", encoding="utf-8") as handle:
            json.dump(merged, handle, indent=2)
    except OSError:
        pass
    return merged


def remember_target(ip, port):
    save_config(last_ip=ip, last_port=str(port))


def _packages(*flags, target=None):
    stdout, _, rc = run_adb("-s", target or state.target, "shell", "pm", "list", "packages", *flags, "--user", "0")
    if rc != 0:
        return set()
    return {line.split(":", 1)[1] for line in stdout.replace("\r", "").splitlines() if line.startswith("package:")}


def device_inventory(target=None):
    """(present, disabled) package sets for the device's user 0."""
    return _packages("-u", target=target), _packages("-d", target=target)


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


def discover():
    """mDNS-advertised adb endpoints plus whatever adb already has attached."""
    services = []
    stdout, _, rc = run_adb("mdns", "services")
    if rc == 0:
        for line in stdout.replace("\r", "").splitlines():
            parts = line.split()
            if len(parts) == 3 and ":" in parts[2] and parts[1].startswith("_adb"):
                services.append({
                    "name": parts[0],
                    "service": parts[1],
                    "address": parts[2],
                    "pairable": parts[1] == "_adb-tls-connect._tcp",
                })
    attached = []
    stdout, _, rc = run_adb("devices")
    if rc == 0:
        for line in stdout.replace("\r", "").splitlines()[1:]:
            fields = line.split()
            if len(fields) >= 2 and ":" in fields[0]:
                attached.append({"address": fields[0], "status": fields[1]})
    return {"services": services, "attached": attached}


def connect(ip, port="5555"):
    if not is_valid_ip(ip):
        return {"ok": False, "message": "Invalid IP address. Enter a valid IPv4 address (e.g. 192.168.1.100)."}
    remember_target(ip, port)
    state.ip = ip
    state.port = str(port)
    stdout, stderr, rc = run_adb("connect", state.target)
    if rc == 0 and ("connected" in stdout or "already connected" in stdout):
        state.connected = True
        return {"ok": True, "message": f"Connected to {state.target}."}
    state.connected = False
    detail = (stderr or stdout).strip() or "No response from adb."
    result = {"ok": False, "message": f"Could not connect to {state.target}. {detail}", "target": state.target}
    lowered = detail.lower()
    if "refused" in lowered or "failed to connect" in lowered or "offline" in lowered or "not found" in lowered:
        result["hint"] = (
            "Android 11+, Google TV and Chromecast builds have no switch named 'ADB Debugging' — it is "
            "Developer options → Wireless debugging. Turn that on, then use 'Pair with a code' below with "
            "the address and 6-digit code from the 'Pair device with pairing code' screen. A TV that has "
            "rebooted or slept also drops its wireless port and needs re-enabling."
        )
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
        save_config(last_pair_port=str(pair_port))
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
    stdout, _, _ = run_adb("devices")
    if state.target not in stdout:
        result = connect(state.ip, state.port)
        return result["ok"]
    return True


def _outcome(stdout, stderr, rc):
    combined = f"{stdout}\n{stderr}".lower()
    if rc == 0 and "new state: disabled" in stdout:
        return True, "Disabled"
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


def _role_packages(query, target):
    out = _shell(f"{query} | grep -o 'packageName=[^ ]*' | sort -u", target)
    return {line.split("=", 1)[1] for line in out.splitlines() if line.startswith("packageName=")}


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
        match = re.match(r"^package:(\S+) installer=(\S+)$", line)
        if match:
            installers[match.group(1)] = match.group(2)
    running = {token for token in _shell("ps -A -o NAME=", target).split() if "." in token}

    roles = {}
    for role, query in ROLE_QUERIES:
        for package in _role_packages(query, target):
            roles.setdefault(package, set()).add(role)

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
            reasons.append("resource overlay — rewrites system resources, not an app")
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


def restore(packages, target=None):
    """Re-enable packages disabled earlier — every action here is reversible."""
    target = target or state.target
    results = []
    for package in packages:
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


def install_apk(local_path):
    remote = f"/sdcard/{os.path.basename(local_path)}"
    push_out, push_err, push_rc = run_adb("-s", state.target, "push", local_path, "/sdcard/")
    if push_rc != 0:
        return {"ok": False, "message": f"Push failed: {(push_err or push_out).strip()}"}
    install_out, install_err, install_rc = run_adb("-s", state.target, "shell", "pm", "install", "-r", remote)
    run_adb("-s", state.target, "shell", "rm", "-f", remote)
    ok = install_rc == 0 and "success" in (install_out or "").lower()
    return {"ok": ok, "message": f"Installed {os.path.basename(local_path)}." if ok
            else f"Install failed: {(install_err or install_out).strip() or 'unknown error'}"}


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
}
