"""Set up this machine to run the toolkit: a real ADB binary.

The repo ships no working ADB (adb/adb.exe is a 2-byte placeholder), so the toolkit
falls back to ADB on PATH. This script installs an official build locally instead,
which the toolkit prefers over PATH, and is new enough for 'adb pair' — the apt
package on Debian/Ubuntu is platform-tools 28.0.2, which predates pairing and so
cannot drive the Pair & Connect flow for Android 11+ / Chromecast with Google TV.

Install the Python requirements separately with:  python -m pip install -r requirements.txt

Usage:  python setup.py [--force]

Despite the filename this is not a setuptools/packaging script — it rejects distutils
commands, so `pip install .` here fails instead of building a package.
"""
import argparse
import importlib.util
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
import zipfile

ARCHIVE = {
    "linux": "platform-tools-latest-linux.zip",
    "darwin": "platform-tools-latest-mac.zip",
    "win32": "platform-tools-latest-windows.zip",
}
BASE_URL = "https://dl.google.com/android/repository/"

# Members to lift out of the archive, per platform. The Windows build needs its
# two helper DLLs next to the executable; the POSIX builds are self-contained.
PAYLOAD = {
    "linux": ["adb"],
    "darwin": ["adb"],
    "win32": ["adb.exe", "AdbWinApi.dll", "AdbWinUsbApi.dll"],
}


def script_dir():
    return os.path.dirname(os.path.abspath(__file__))


def bundled_adb(platform):
    name = "adb.exe" if platform == "win32" else "adb"
    return os.path.join(script_dir(), "adb", name)


def probe(adb_path):
    """Return (version_line, supports_pair) for an adb binary, or (None, False)."""
    try:
        version = subprocess.run(
            [adb_path, "version"], capture_output=True, text=True, timeout=20
        ).stdout.strip().splitlines()[0]
    except (OSError, IndexError, subprocess.TimeoutExpired):
        return None, False
    try:
        help_out = subprocess.run(
            [adb_path, "pair"], capture_output=True, text=True, timeout=20
        )
        supported = "unknown command" not in (help_out.stdout + help_out.stderr).lower()
    except OSError:
        supported = False
    return version, supported


def download(url, dest):
    print(f"Downloading {url}")
    with urllib.request.urlopen(url, timeout=120) as response, open(dest, "wb") as out:
        total = int(response.headers.get("Content-Length") or 0)
        done = 0
        while True:
            chunk = response.read(1 << 16)
            if not chunk:
                break
            out.write(chunk)
            done += len(chunk)
            if total:
                print(f"\r  {done / 1048576:.1f} / {total / 1048576:.1f} MiB", end="", flush=True)
        print()


def ensure_adb(platform, force):
    """Install a platform-tools ADB into adb/. Return False if it could not be done."""
    target = bundled_adb(platform)
    os.makedirs(os.path.dirname(target), exist_ok=True)

    if os.access(target, os.X_OK) and not force:
        version, pair_ok = probe(target)
        if version and pair_ok:
            print(f"ADB already set up: {target}\n  {version}\n  'adb pair' supported — nothing to do (use --force to refetch).")
            return True
        if version:
            print(f"Existing {target} ({version}) lacks 'adb pair' — replacing it.")

    # A stale server started by an older client gets restarted anyway, but say so
    # rather than leaving the user to wonder about a version-mismatch notice.
    path_adb = shutil.which("adb")
    if path_adb:
        subprocess.run([path_adb, "kill-server"], capture_output=True, text=True, timeout=30)

    payload = PAYLOAD[platform]
    with tempfile.TemporaryDirectory() as tmp:
        archive = os.path.join(tmp, ARCHIVE[platform])
        try:
            download(BASE_URL + ARCHIVE[platform], archive)
        except (urllib.error.URLError, OSError) as exc:
            print(f"Download failed: {exc}\nCheck your network/proxy, then re-run.")
            return False

        with zipfile.ZipFile(archive) as zf:
            names = zf.namelist()
            for member in payload:
                src = f"platform-tools/{member}"
                if src not in names:
                    print(f"Unexpected archive layout: '{src}' is missing.")
                    return False
                with zf.open(src) as read, open(os.path.join(os.path.dirname(target), member), "wb") as write:
                    shutil.copyfileobj(read, write)

    if platform != "win32":
        os.chmod(target, os.stat(target).st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)

    version, pair_ok = probe(target)
    if not version:
        print(f"Downloaded but cannot execute {target}. On Linux you may need "
              "'sudo apt install libc++1' or the newer platform-tools for your arch.")
        return False

    print(f"\nInstalled {target}\n  {version}\n  'adb pair': {'supported' if pair_ok else 'NOT supported'}")
    print("The toolkit prefers this binary over adb on PATH. No reboot or PATH change needed.")
    if platform == "win32":
        print("Note: adb/adb.exe is tracked in git as a placeholder, so it now shows as modified — do not commit it.")
    return True


def main():
    parser = argparse.ArgumentParser(description="Install a real ADB binary for the toolkit.")
    parser.add_argument("--force", action="store_true", help="re-download ADB even if a working one is already present")
    args = parser.parse_args()

    if sys.platform not in ARCHIVE:
        sys.exit(f"Unsupported platform '{sys.platform}'. Fetch ADB manually from "
                 "https://developer.android.com/studio/releases/platform-tools")

    adb_ok = ensure_adb(sys.platform, args.force)

    flask = "installed" if importlib.util.find_spec("flask") else "MISSING — run: python -m pip install -r requirements.txt"
    print("\nSummary")
    print(f"  ADB .............. {'ready' if adb_ok else 'NOT ready'}")
    print(f"  Flask ............ {flask}")
    sys.exit(0 if adb_ok else 1)


if __name__ == "__main__":
    main()
