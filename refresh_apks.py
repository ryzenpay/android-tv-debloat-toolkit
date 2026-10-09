#!/usr/bin/env python3
"""Fill apks/ with the recommended apps, one file per entry, chosen for the device's instruction set.

    python3 refresh_apks.py                 # fetch anything missing or out of date
    python3 refresh_apks.py --abi arm64-v8a # a different box
    python3 refresh_apks.py --list          # what is cached right now, no network

The page offers an Install button for whatever this leaves in apks/, so a project can be dropped from
REPOS (or the file deleted) and the button disappears on its own — the button is a consequence of the
file being here, never a claim made in markup.

Each entry is resolved through adb_core.github_apk, the same picker the toolkit uses for a pasted
GitHub link: newest release, assets scored so a build that cannot run on this instruction set loses,
and wear/automotive files ruled out.
"""
import argparse
import hashlib
import json
import re
import urllib.request
from pathlib import Path

import adb_core

APKS = Path(__file__).with_name("apks")
INDEX = APKS / "index.json"
USER_AGENT = "android-tv-toolkit"

# repo, what the card calls it. Keep short: every entry is a file in git.
REPOS = [
    ("yuliskov/SmartTube", "SmartTube"),
    ("home-assistant/android", "Home Assistant"),
    ("jellyfin/jellyfin-androidtv", "Jellyfin"),
    ("ReVanced/revanced-manager", "ReVanced Manager"),
    ("nova-video-player/aos-AVP", "Nova Video Player"),
    ("localsend/localsend", "LocalSend"),
]


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def slugify(name):
    """A filename that survives a round trip through a URL, a filesystem and git."""
    return re.sub(r"[^A-Za-z0-9._-]", "_", name).strip("_") or "app.apk"


def fetch(repo, abi):
    """Download the release asset this box should run; returns the manifest row, or a reason it failed."""
    found = adb_core.github_apk(repo, abi)
    if not found.get("ok"):
        return None, found["message"]
    target = APKS / slugify(f"{repo.replace('/', '.')}-{found['name']}")
    request = urllib.request.Request(found["url"], headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=adb_core.DOWNLOAD_TIMEOUT) as served:
        declared = int(served.headers.get("Content-Length") or 0)
        if declared > adb_core.MAX_DOWNLOAD_BYTES:
            return None, (f"{found['name']} is {declared / 1048576:.1f} MB, over the "
                          f"{adb_core.MAX_DOWNLOAD_BYTES // 1048576} MB limit this tool will handle — "
                          "it cannot live in a git repository either.")
        APKS.mkdir(exist_ok=True)
        partial = target.with_suffix(target.suffix + ".part")
        with open(partial, "wb") as sink:
            while chunk := served.read(1024 * 1024):
                sink.write(chunk)
    partial.replace(target)
    return {
        "repo": repo,
        "asset": found["name"],
        "tag": found["tag"],
        "file": target.name,
        "bytes": target.stat().st_size,
        "sha256": sha256(target),
        "abi": abi,
    }, ""


def main():
    parser = argparse.ArgumentParser(description="Cache the recommended APKs for this instruction set.")
    parser.add_argument("--abi", default=adb_core.device_abi() or "arm64-v8a",
                        help="instruction set to cache for (default: the connected device's, else arm64-v8a)")
    parser.add_argument("--force", action="store_true", help="re-download even when the release already matches")
    parser.add_argument("--list", action="store_true", help="print the cache and exit")
    args = parser.parse_args()

    current = {}
    if INDEX.is_file():
        current = {row["repo"]: row for row in json.loads(INDEX.read_text()).get("files", [])}
    if args.list:
        for row in current.values():
            print(f"{row['repo']:34} {row['tag']:16} {row['bytes'] / 1048576:7.1f} MB  {row['file']}")
        if not current:
            print("apks/index.json holds nothing yet — run refresh_apks.py")
        return

    rows, problems = [], []
    for repo, label in REPOS:
        cached = current.get(repo)
        if cached and not args.force:
            probe = adb_core.github_apk(repo, args.abi)
            if probe.get("ok") and probe["tag"] == cached["tag"] and (APKS / cached["file"]).is_file():
                print(f"= {label:20} {cached['tag']:16} already cached")
                rows.append(cached)
                continue
        print(f"v {label:20} fetching …", flush=True)
        try:
            row, problem = fetch(repo, args.abi)
        except Exception as exc:                      # one project's outage must not stop the others
            row, problem = None, f"could not fetch: {exc}"
        if row:
            stale = cached and cached["file"] != row["file"] and (APKS / cached["file"]).is_file()
            if stale:
                (APKS / cached["file"]).unlink()       # an old build has no business being served
            rows.append(row)
            print(f"  {label:20} {row['tag']:16} {row['bytes'] / 1048576:7.1f} MB  {row['file']}")
        else:
            problems.append(f"{label}: {problem}")
            if cached and (APKS / cached["file"]).is_file():
                rows.append(cached)                    # keep serving the older copy rather than nothing

    known = {row["file"] for row in rows}
    for stray in APKS.glob("*.apk") if APKS.is_dir() else []:
        if stray.name not in known:
            stray.unlink()

    INDEX.write_text(json.dumps({"abi": args.abi, "files": sorted(rows, key=lambda r: r["repo"])},
                                indent=2) + "\n")
    total = sum(row["bytes"] for row in rows) / 1048576
    print(f"\n{len(rows)} files cached for {args.abi}, {total:.1f} MB in apks/ -> {INDEX.name}")
    for problem in problems:
        print(f"! {problem}")


if __name__ == "__main__":
    main()
