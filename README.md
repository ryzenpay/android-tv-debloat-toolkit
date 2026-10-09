<p align="center">
  <img src="banner.PNG" alt="Android TV Toolkit" width="1000" style="height:auto;">
</p>

# Android TV Toolkit

A web page that talks to an Android TV / Google TV box over ADB: read what is actually installed on the device
and disable the junk (reversibly), install APKs from a file, a link, or a GitHub project, swap the launcher,
grab screenshots, and drive the remote from the browser. Nothing about your devices leaves your network — the
server is your own machine, and the TV address is kept in your browser, not on the server.

The app is four files: `app.py` (routes), `adb_core.py` (every ADB call), `templates/index.html` (the page),
`static/` (its CSS and JavaScript, served exactly as written — there is no build step).

---

## Run it

### With Docker

```
docker compose up -d --build
```

Open **http://127.0.0.1:8000/** — type `127.0.0.1`, not `localhost`. On WSL2 in mirrored networking mode a
Windows browser resolves `localhost` to `::1` first and WSL does not forward `::1` to Windows, so the page just
spins. Logs: `docker compose logs -f` · stop: `docker compose down` · rebuild after editing: the same command.

The image installs Python, Flask and a real ADB for you (`setup.py` runs during the build, so `adb pair`
works). Two things in `docker-compose.yml` are load-bearing:

- **`network_mode: host`** — the container is an ADB *client*, and it listens for the mDNS announcements behind
  *Discovered on your network*. Bridge NAT drops the multicast half, so discovery comes back empty. If your
  Docker has no host networking, comment the line out, add `ports: ["8000:8000"]`, and type the TV's IP in by
  hand instead of using discovery.
- **`TOOLKIT_HOST: "0.0.0.0"`** — see [Who can reach the page](#who-can-reach-the-page).

### Without Docker

```
pip install -r requirements.txt      # Flask is the only dependency
python setup.py                      # fetches a working adb into adb/ — see below
python app.py                        # prints the URL and opens your browser
```

Starts on `http://127.0.0.1:5000/` (next free port up to 5009 if taken). `--host`, `--port` and `--no-browser`
override; the same three are read from `TOOLKIT_HOST`, `TOOLKIT_PORT` and `TOOLKIT_NO_BROWSER`, which is how the
container configures them.

`python setup.py` downloads the official [platform-tools](https://developer.android.com/studio/releases/platform-tools)
build into `adb/`, marks it executable and confirms `adb pair` works. Skip it if you already have a recent ADB on
your PATH — the toolkit uses that automatically. It matters on Debian/Ubuntu/WSL, where the `adb` in apt is
platform-tools 28.0.2, which predates pairing and cannot run **Pair & Connect**. Re-run any time; `--force` refetches.

---

## On the TV

The one thing the page cannot do for you — everything else is on screen:

1. **Settings → Device Preferences → About → Build number**, clicked 7 times, unlocks Developer Options.
2. **Developer Options → Wireless debugging** (Android 11+, Google TV, Chromecast, Onn and similar). These builds
   have no switch called "ADB debugging"; turn Wireless debugging on and open **Pair device with pairing code**,
   then keep that screen open — it shows the pairing port and the 6-digit code the page asks for. The separate
   "IP address & port" on the main Wireless debugging screen is the *connect* address, not the pairing one.
   Older Android TV builds have plain **ADB debugging** and need only the IP, port 5555.

Wireless debugging switches itself off after a reboot or when the box sleeps, so a device that worked yesterday
may need the toggle re-enabled — and re-pairing, because the code changes each time.

After that: the *Discovered on your network* panel should already list the box (**Use for pairing**), the address
you connect with is saved in that browser so the next visit reconnects by itself (**Forget** clears it), and if the
TV rebooted the page prints why and opens the pairing form.

---

## The page walks you through the rest

Each card is self-explanatory and reads live from the device — nothing is a fixed vendor list:

**Connect / discover** · **Device** (build, serial, uptime, memory, storage, IP, launcher, screenshot, logcat, reboot)
· **Apps** (verdict per package with the reason it was derived, filters, disable / re-enable, per-app info and actions,
uninstall) · **Remote control** (each press re-grabs the screenshot) · **System tunables** (animation scales, stay-awake,
each with a reset to factory) · **Install APK** (file, direct link, or GitHub project link — resolved to the asset built
for this box's instruction set; plus the recommended-for-TV list) · **Launcher** (reads the HOME role, sets it, installs
a replacement, disables the stock one).

Two behaviours worth knowing before you press things:

- Core and overlay packages are **refused** unless you tick the override. Disabling is `pm disable-user --user 0`, and
  the *Disabled* filter lists everything switched off on the device — including packages disabled outside this tool —
  with one-click re-enable.
- Install a replacement launcher and confirm it works **before** disabling the stock one. The remote card is how you
  get back into Settings if you get ahead of yourself.

---

## Who can reach the page

There is **no authentication** — anyone who can open the page can change the TV. `TOOLKIT_HOST` is the whole access
control: `0.0.0.0` (what the compose file ships) serves every interface, so anyone on your LAN can disable
packages, install APKs, or reboot the box; `127.0.0.1` keeps it to the machine it runs on. It is the Flask
development server with no TLS, so do not expose it beyond your own network.

One consequence of `network_mode: host` measured on WSL2: the container shares the host's network stack, so its
`adb` client attaches to the adb *server* already listening on `127.0.0.1:5037` — the one your user started — and
only one process can hold that port. The keypair the TV actually authorised is therefore the host user's
`~/.android/adbkey`, and the `adb-keys` volume stays empty. Pairing survives rebuilds and `docker compose down -v`,
but back up the host key, not the volume. On a setup with no host adb server (Docker Desktop in a VM, or the bridge
fallback above) the volume is what holds it, and losing it means pairing again with a fresh code.

---

## Two things that go wrong

**`adb: unknown command pair`** — your ADB is older than platform-tools 31. `python setup.py` fetches the official build.

**The page spins and never loads** — you used `localhost`. Use `http://127.0.0.1:8000/` (or whatever port was printed).

A connection that worked before and does not now is almost always Wireless debugging having switched off, or the TV
having forgotten this computer: re-enable the toggle and pair again with a fresh code.

---

## FAQ

**Can the page be public while the TV stays private — can ADB run in the browser instead of on a server?**
Half of it, and only over USB. A browser cannot open a raw TCP socket, so nothing written in JavaScript can reach
the TV's wireless debugging port (`ip:5555`) directly, nor send the multicast queries discovery relies on. What
browsers *can* do is [WebUSB](https://github.com/yujincheng08/WebAdb): claim the TV over a USB cable and speak the
ADB protocol in the page, keypair included. Chrome and Edge do WebUSB; Safari on macOS and iOS does not implement
it at all, so an iPhone or iPad can never be the client. For the wireless case there are two shapes that keep the
TV off the internet: this design (a small server on your LAN is the ADB client — the page can live anywhere), or
a static public page plus a ~50-line WebSocket↔TCP relay on the machine you are browsing from, which the browser
reaches at `ws://127.0.0.1:<port>`. The relay still has to run somewhere that can see the TV — it shrinks the local
process and moves the UI to a static host, it does not remove the process.

**Will this work on my device?**
Anything that accepts ADB over the network — TCL TVs, Onn boxes, Nvidia Shield, Chromecast with Google TV via
Pair & Connect. Unsure? Connect and just read the app list without disabling anything.

**Can I break the TV?**
Risk comes from your device, not from a curated list: home/launcher, input method, accessibility, device admin,
system-uid and overlay packages are classified *core* or *overlay* and refused unless you tick the override.
Everything else states why it is flagged, and anything disabled here is re-enable-able from the same screen.

**Is it maintained?**
Not actively. It works as described and issues are read, but updates may be slow. The source is short — pull
requests welcome.

---

## License

MIT — see [LICENSE](LICENSE).
