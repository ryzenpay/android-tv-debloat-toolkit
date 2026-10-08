<p align="center">
  <img src="banner.PNG" alt="Android TV Toolkit" width="1000" style="height:auto;">
</p>

[![Latest Release](https://img.shields.io/github/v/release/seun-novodev/android-tv-debloat-toolkit?style=for-the-badge)](https://github.com/seun-novodev/android-tv-debloat-toolkit/releases/latest)

# Android TV Toolkit

Lightweight web app to debloat Android TV / Google TV devices, install APKs, and customize the TV experience.

Built using Python and Flask. It runs locally and opens in your browser — nothing leaves your network.

> **Maintenance status:** This project is not actively maintained. It works as described and issues are read, but updates and responses may be slow. Pull requests are welcome — see the source code, it's short and straightforward.

---

## Features
- Detects what is actually installed on *your* device — no fixed vendor list
- Discovers TVs advertising Wireless debugging on your network
- Connect to Android TV over Wi-Fi (ADB Wireless)
- Pair & Connect for Android 11+ / Chromecast with Google TV (Wireless Debugging)
- Debloat bloatware, with every action reversible (`pm enable`)
- Remove Google TV Recommendations
- Install APKs remotely (FLauncher included)
- Disable Google Launcher safely (after installing a custom launcher)
- Reboot TV remotely

---

## ⚠️ Why Did Antivirus Flag This as a Trojan?

**Short answer: it was a false positive. There is no trojan, spyware, or malicious code in this project.**

Previous versions included a pre-built `run_toolkit.exe` file. This triggered antivirus warnings for three reasons — none of which involve actual malware:

1. **PyInstaller packaging** — The exe was built with PyInstaller, which bundles a Python runtime and unpacks itself into a temporary folder at launch. This self-extracting behaviour is identical to how some malware operates, so antivirus tools flag it heuristically even when the code inside is completely clean.
2. **Shell command execution** — The old code used `os.popen()` to run ADB commands, which passes commands through the Windows shell. Antivirus tools see a GUI program silently spawning shell processes and treat it as suspicious.
3. **Bundled ADB binaries** — Shipping `adb.exe` inside a zip alongside an unsigned executable is another common malware pattern that triggers heuristic detection.

**What changed in v1.2:**
- The pre-built `run_toolkit.exe` has been **removed from the repo entirely**. You run the toolkit directly from the Python source — no packaging, nothing to flag.
- All shell commands have been rewritten to use Python's `subprocess` module with explicit argument lists (no shell involvement), which is both safer and less suspicious to antivirus tools.
- Input validation was added so no user-supplied data is ever passed unsanitised to a system command.

You are encouraged to read the source code yourself — `app.py` is the web UI, `adb_core.py` is every ADB call — it is short, straightforward, and does exactly what it says.

---

## Requirements
- Windows 10 or 11 (macOS and Linux, including WSL, also work — see [setup.py](setup.py))
- **Python 3.8 or later** — [Download from python.org](https://www.python.org/downloads/)
- **Python dependencies** — `pip install -r requirements.txt` (Flask is the only one)
- Or **Docker** instead of Steps 1–2 and 4 — see [Run it in a container](#-run-it-in-a-container-optional)
- TV must have Developer Options enabled
- **ADB debugging** or **Wireless debugging** turned ON (see Step 5 — newer builds only have the latter)
- TV and PC must be on the same Wi-Fi network

---

## 🚀 Setup & Usage (v1.2+)

### Step 1 — Install Python

Download and install Python 3.8+ from [python.org](https://www.python.org/downloads/).  
During installation, check **"Add Python to PATH"**.

### Step 2 — Install the Python dependencies

Open a Command Prompt and run:

```
pip install -r requirements.txt
```

### Step 3 — Download this project

Click the green **Code** button on this page → **Download ZIP**, then unzip it anywhere.

### Step 4 — Install a working ADB (recommended)

The `adb/` folder does **not** contain a usable ADB — the repo ships no working binary on purpose (see the antivirus note above). Run this once from the project folder:

```
python setup.py
```

It downloads the official build from Google's [platform-tools](https://developer.android.com/studio/releases/platform-tools) into `adb/`, marks it executable, and confirms `adb pair` works — the version in apt on Debian/Ubuntu is platform-tools 28.0.2, which predates pairing and cannot run **Pair & Connect**. It's safe to re-run, and `--force` refetches.

Skip this step if you already have a recent ADB on your PATH — the toolkit uses that automatically.

### Step 5 — Enable debugging on your TV

1. Go to **Settings → Device Preferences → About → Build Number** and click it 7 times to unlock Developer Options.
2. Open **Settings → Device Preferences → Developer Options** and turn on whichever of these your build shows:
   - **ADB debugging** — older Android TV builds. Connect with the TV's IP address, port 5555.
   - **Wireless debugging** — Android 11+, Google TV, Chromecast with Google TV, Onn and similar. **There is no
     switch called "ADB debugging" on these builds.** Turn Wireless debugging on, open **Pair device with pairing
     code**, and keep that screen open: it shows the IP + pairing port + a 6-digit code you enter in Step 7.
     The main Wireless debugging screen also shows a separate **"IP address & port"** — that is the *connect*
     address, not the pairing one.

Wireless debugging switches off after a reboot or when the box sleeps, so a device that worked yesterday may
need the toggle re-enabled (and re-pairing) today.

### Step 6 — Run the Toolkit

From the project folder:

```
python app.py
```

That starts a local web server and opens `http://127.0.0.1:5000/` in your browser. Options: `--port`,
`--host 0.0.0.0` (to open it to other machines — off by default on purpose), `--no-browser`. If port 5000 is
taken, the next free port up to 5009 is used and printed. The same three settings can be set with the
`TOOLKIT_HOST`, `TOOLKIT_PORT` and `TOOLKIT_NO_BROWSER` environment variables, which is how the container
configures them.

### Step 7 — Connect and use

**Android 11+ / Google TV / Chromecast / Onn (the common case now):**
1. With **Wireless debugging** open on the TV, the toolkit's *Discovered on your network* panel should already
   list the device — click **Use for pairing**.
2. Enter the **Pairing port** and 6-digit **Pairing code** from the TV, plus the **Debug port** shown under
   "IP address & Port", then **Pair & Connect**.

**Older Android TV builds:**
1. Enter the TV's IP address (find it under **Settings → Network → About**) and click **Connect**.

Once connected, **Apps on this device** reads the real package list and classifies each entry from device
facts — partition, shared uid, system roles (home, input method, accessibility, device admin), installer and
whether a process is running. Filter by *Documented bloat*, *Careful*, *Undocumented* or *Keep*. Core and
overlay packages are refused unless you tick the override, and everything disabled here can be re-enabled from
the same screen.

- **Install APK** — install apps directly to the TV
- **Disable Google TV Launcher** — only after installing a backup launcher like FLauncher

---

## 🐳 Run it in a container (optional)

If you would rather not install Python or ADB on the host, `docker-compose.yml` builds the whole thing —
Python, Flask and a real ADB (the image runs `setup.py` during the build, so `adb pair` works):

```
docker compose up -d --build
```

Then open **http://127.0.0.1:8000/** and use Steps 5 and 7 as usual. Logs: `docker compose logs -f`; stop:
`docker compose down`; rebuild after editing the code: `docker compose up -d --build`.

What the compose file does and why:

- **`network_mode: host`** — the container is an ADB *client*: it opens outbound connections to the TV and
  listens for the mDNS announcements behind *Discovered on your network*. Bridge NAT drops the multicast
  half, so discovery would come back empty. If your Docker build has no host networking (older Docker
  Desktop), comment that line out, add `ports: ["8000:8000"]`, and type the TV's IP in manually instead of
  using discovery.
- **`TOOLKIT_HOST: "0.0.0.0"`** — IPv4, all interfaces. On WSL2 in mirrored mode, `localhost` from a
  Windows browser resolves to `::1` first and WSL does not forward `::1` (nor the mirrored LAN address)
  to Windows, so **open `http://127.0.0.1:8000/`**, not `http://localhost:8000/`, or the page just spins.
  The bind stays IPv4 so Flask's startup line is one you can actually click — binding `::` prints
  `http://[::1]:8000`, which nothing on the Windows side can reach. Set `127.0.0.1` here if you want the
  page loopback-only: it can enable and disable packages on your TV.
- **Two named volumes** — `adb-keys` (`/home/toolkit/.android`, the keypair Pair & Connect registers with
  the TV; lose it and you must pair again) and `toolkit-data` (`/data/config.json`, the remembered IP and
  ports). `TOOLKIT_CONFIG` points at the latter so nothing stateful lives in the container filesystem.
- The container runs as an unprivileged user and only ever talks to devices on your own network. It is the
  Flask development server, which is fine for one local user; it is not a hardened internet-facing service,
  so do not expose port 8000 beyond your LAN.

---

## Optional: FLauncher (Custom Launcher)

If you plan to disable the Google TV Launcher, install a backup launcher first so you don't get locked out.

1. Download the FLauncher APK from [APKPure](https://apkpure.com/flauncher/me.efesser.flauncher).
2. Use the **Install APK** button in the Toolkit to push it to your TV.
3. Open FLauncher from your TV's Apps list to confirm it works.
4. Then use **Disable Google TV Launcher** in the Toolkit.

✅ FLauncher is open-source, ad-free, and maintained by the community.

---

## 🛠️ Troubleshooting: ADB Connection Issues

**"adb not found" error:**
The toolkit looks for ADB in the `adb/` folder next to the script. Make sure you unzipped the full project (not just the `.py` file).

**Running on Linux / macOS (including WSL):**
The `adb/` folder ships Windows binaries only, so on those platforms the toolkit uses `adb` from your PATH instead. Easiest fix is `python setup.py`, which drops a native binary into `adb/` — that copy takes priority over PATH. Otherwise `sudo apt install adb` (Debian/Ubuntu/WSL) or `brew install android-platform-tools` (macOS). Note that the Debian/Ubuntu package is platform-tools 28.0.2 and has no `adb pair`, so Pair & Connect needs the official build.

**"Unknown package" / a Java stack trace when disabling an app:**
That package isn't installed on your device, so there was nothing to disable — it is not a failure. The app
list is now read from the device rather than from a fixed vendor list, so this should no longer be offered to
you; if it appears for a package you can see on screen, re-run **Rescan packages**.

**"adb: unknown command pair":**
Your adb is older than platform-tools 31. The apt package on Debian/Ubuntu is 28.0.2 and has no pairing
support — run `python setup.py` to fetch the official build.

**32-bit ADB / incompatible with 64-bit Windows:**
The bundled `adb.exe` may be 32-bit. Replace the files in the `adb/` folder with the latest 64-bit version:
- Download from [Google's official platform-tools](https://developer.android.com/studio/releases/platform-tools)
- Copy `adb.exe`, `AdbWinApi.dll`, and `AdbWinUsbApi.dll` into the `adb/` folder, replacing the existing files

**"Failed to connect" / "connection refused":**
- Make sure ADB Debugging is enabled on the TV
- Make sure the TV and PC are on the same Wi-Fi network
- If using a Chromecast or Android 11+ device, use the **Pair & Connect** button instead of **Connect to TV**

---

## 📖 FAQ

**Q: Do I need to install anything to run the Toolkit?**  
**A:** Python 3.8+ and Flask (`pip install -r requirements.txt`) — or Docker and neither of those, see
[Run it in a container](#-run-it-in-a-container-optional). This replaced the old `.exe` approach to eliminate antivirus false positives.

**Q: Will this work on all Android TV devices?**  
**A:** The Toolkit is designed for devices that support ADB Debugging — TCL TVs, Onn 4K boxes, and Nvidia Shield TV. Chromecast with Google TV is supported via the Pair & Connect option. If you are unsure about your device, connect and just read the app list without disabling anything.

**Q: Is there a risk of disabling important apps?**  
**A:** Risk comes from your device, not from a curated list: launcher/home, input method, accessibility, device admin, system-uid and overlay packages are classified *core* or *overlay* and refused unless you tick the override. Everything else shows why it is flagged — partition, uid, roles, installer, whether a process is running — and anything disabled here can be re-enabled from the same screen.

**Q: Is the Toolkit free to use?**  
**A:** Yes — fully open-source under the MIT License.

**Q: The old `.exe` got flagged by my antivirus. Is this version safe?**  
**A:** Yes. See the [Why Did Antivirus Flag This?](#️-why-did-antivirus-flag-this-as-a-trojan) section above. Running from Python source removes every trigger that caused those false positives.

**Q: Is this project actively maintained?**  
**A:** Not actively. The toolkit works as described and issues are read, but updates may be infrequent. The source code is short and well-structured — contributions via pull request are welcome.

---

## What Changed in v1.2

| Area | Before | After |
|---|---|---|
| Distribution | Pre-built `run_toolkit.exe` (PyInstaller) | Run from Python source directly |
| Shell commands | `os.popen()` — passes through Windows shell | `subprocess.run()` with argument lists — no shell |
| Input validation | None — raw user input passed to commands | IP address validated before any ADB call |
| Error reporting | Fragile string matching on command output | Return codes checked; errors shown clearly |
| ADB target | Port hardcoded to 5555 in some places | Consistent `ip:port` target throughout |
| State management | Global variables | `TVConnection` class |
| Android 11+ / Chromecast | Not supported | New Pair & Connect flow |

---



## 🔨 Building Your Own Windows Executable (Optional)

Some people prefer to use a `.exe` file rather than running a Python script — it feels more like a normal Windows app. You can build one yourself from the source code. Because **you** built it on **your** machine, Windows will trust it.

> **Why not just download a pre-built exe?** A pre-built exe created by someone else will often trigger antivirus warnings — not because it contains malware, but because Windows is suspicious of executables from the internet that it hasn't seen before. Building it yourself avoids this entirely.

### What you need first

Make sure you have already completed Steps 1 and 2 from the Setup section above (Python installed and Flask installed), and Step 4 (`python setup.py`), because the build bundles the `adb/` folder it downloads.

### Step-by-step

**Step 1 — Install PyInstaller**

PyInstaller is a free tool that packages a Python script into a standalone `.exe`. Open a Command Prompt and run:

```
pip install pyinstaller
```

This downloads and installs PyInstaller automatically. You only need to do this once.

**Step 2 — Open a Command Prompt in the project folder**

Navigate to the folder where you unzipped this project. Click the address bar at the top of File Explorer, type `cmd`, and press Enter. This opens a Command Prompt already pointing at the right folder.

**Step 3 — Run the build command**

Type the following and press Enter:

```
pyinstaller --onefile --add-data "templates;templates" --add-data "adb;adb" app.py
```

What this does:
- `--onefile` packages everything into a single `.exe` file (easier to use)
- `--add-data "templates;templates"` ships the web page — Flask looks for it next to the code, and a frozen
  build unpacks to a temporary folder, so it has to be inside the bundle
- `--add-data "adb;adb"` bundles the ADB that `python setup.py` downloaded; leave it out and the exe falls
  back to `adb` on your PATH

Omit `--windowed`: the console is what prints the URL, and the toolkit opens your browser itself.

This will take 30–60 seconds. You will see a lot of text scroll by — that is normal.

**Step 4 — Find your exe**

When it finishes, open the `dist` folder inside the project folder. Your `app.exe` is in there. You can move it anywhere you like — your Desktop, for example.

> **Note:** This exe will work on your machine but may still trigger antivirus warnings if you send it to someone else. That is expected behaviour — see the [Why Did Antivirus Flag This?](#️-why-did-antivirus-flag-this-as-a-trojan) section. If you want to share the toolkit with someone, send them the Python source and point them to the Setup instructions instead.
## Credits

Inspired by the Reddit Android TV community.  
Built for the community to simplify TV customization.

---

![Open Source](https://img.shields.io/badge/Open%20Source-MIT%20License-brightgreen?style=for-the-badge)

## License
This project is licensed under the MIT License.