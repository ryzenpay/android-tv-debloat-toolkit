"""Android TV Toolkit — Flask web UI. Run: python app.py"""
import argparse
import os
import socket
import tempfile
import threading
import webbrowser

from flask import Flask, Response, jsonify, render_template, request
from werkzeug.utils import secure_filename

import adb_core as core

app = Flask(__name__)


def _connected_or_error():
    if core.state.connected and core.reconnect_check():
        return None
    return jsonify({"ok": False, "message": "Not connected. Connect to your TV first."}), 409


@app.before_request
def reject_cross_origin_mutation():
    """There is no login, so a same-origin check is what stands between a random web page and
    these routes: a form post needs no preflight and, on the body-free routes, no body at all."""
    if request.method in ("GET", "HEAD", "OPTIONS"):
        return None
    if (request.headers.get("Sec-Fetch-Site") or "").lower() in ("cross-site", "cross-origin"):
        return jsonify({"ok": False, "message": "Blocked: cross-origin request."}), 403
    origin = request.headers.get("Origin") or ""
    if origin and origin != request.host_url.rstrip("/"):
        return jsonify({"ok": False, "message": "Blocked: cross-origin request."}), 403
    return None


@app.get("/")
def index():
    return render_template("index.html")


@app.get("/api/state")
def api_state():
    payload = {
        "connected": core.state.connected,
        "target": core.state.target if core.state.connected else "",
        "adb": core.ADB,
        "device": None,
    }
    if core.state.connected:
        payload["device"] = core.device_info()
    return jsonify(payload)


@app.get("/api/discover")
def api_discover():
    return jsonify(core.discover())


@app.get("/api/inventory")
def api_inventory():
    blocked = _connected_or_error()
    if blocked:
        return blocked
    rows = core.detect_packages()
    return jsonify({
        "ok": True,
        "device": core.device_info(),
        "apps": rows,
        "counts": {
            "total": len(rows),
            "bloat": sum(1 for r in rows if r["verdict"] == "bloat" and r["state"] == "enabled"),
            "disabled": sum(1 for r in rows if r["state"] == "disabled"),
        },
    })


@app.post("/api/connect")
def api_connect():
    payload = request.get_json(silent=True) or {}
    result = core.connect(str(payload.get("ip", "")).strip(), str(payload.get("port", "5555")).strip() or "5555")
    return jsonify(result), (200 if result["ok"] else 400)


@app.post("/api/pair")
def api_pair():
    payload = request.get_json(silent=True) or {}
    result = core.pair_and_connect(
        str(payload.get("ip", "")).strip(),
        str(payload.get("pair_port", "")).strip(),
        str(payload.get("code", "")).strip(),
        str(payload.get("debug_port", "5555")).strip() or "5555",
    )
    return jsonify(result), (200 if result["ok"] else 400)


@app.post("/api/disconnect")
def api_disconnect():
    return jsonify(core.disconnect())


@app.post("/api/debloat")
def api_debloat():
    blocked = _connected_or_error()
    if blocked:
        return blocked
    payload = request.get_json(silent=True) or {}
    packages = payload.get("packages", [])
    if not isinstance(packages, list) or not packages:
        return jsonify({"ok": False, "message": "No apps selected."}), 400

    results = core.debloat([(package, package) for package in packages],
                           confirm_core=bool(payload.get("confirm_core")))
    done = sum(1 for row in results if row["ok"])
    return jsonify({
        "ok": done == len(results),
        "results": results,
        "message": f"{done} of {len(results)} handled.",
    })


@app.post("/api/restore")
def api_restore():
    blocked = _connected_or_error()
    if blocked:
        return blocked
    packages = (request.get_json(silent=True) or {}).get("packages", [])
    if not isinstance(packages, list) or not packages:
        return jsonify({"ok": False, "message": "Nothing selected."}), 400

    results = core.restore(packages)
    done = sum(1 for row in results if row["ok"])
    return jsonify({
        "ok": done == len(results),
        "results": results,
        "message": f"{done} of {len(results)} re-enabled.",
    })


@app.post("/api/launcher/disable")
def api_disable_launcher():
    blocked = _connected_or_error()
    if blocked:
        return blocked
    result = core.disable_launcher()
    return jsonify(result), (200 if result["ok"] else 400)


@app.post("/api/install")
def api_install():
    blocked = _connected_or_error()
    if blocked:
        return blocked
    upload = request.files.get("file")
    if upload and upload.filename:
        name = secure_filename(upload.filename) or "app.apk"
        handle, path = tempfile.mkstemp(suffix=".apk")
        os.close(handle)
        try:
            upload.save(path)
            result = core.install_apk(path, name)
        finally:
            try:
                os.remove(path)
            except OSError:
                pass
        return jsonify(result), (200 if result["ok"] else 400)

    url = str((request.get_json(silent=True) or {}).get("url", "")).strip()
    if url:
        # The ABI goes with it so a GitHub link resolves to the asset that runs on this box.
        download = core.download_apk(url, core.device_abi())
        if not download["ok"]:
            return jsonify(download), 400
        path = download["path"]
        name = secure_filename(download["name"]) or "app.apk"
        try:
            result = core.install_apk(path, name)
            if result["ok"]:
                result["message"] = f"Installed {name} ({download['bytes'] / 1048576:.1f} MB)."
        finally:
            try:
                os.remove(path)
            except OSError:
                pass
        return jsonify(result), (200 if result["ok"] else 400)

    return jsonify({"ok": False, "message": "No APK selected."}), 400


@app.get("/api/device")
def api_device():
    blocked = _connected_or_error()
    if blocked:
        return blocked
    return jsonify({"ok": True, "device": core.device_info(), "telemetry": core.telemetry()})


@app.get("/api/screenshot")
def api_screenshot():
    blocked = _connected_or_error()
    if blocked:
        return blocked
    image, message = core.screenshot()
    if image is None:
        return jsonify({"ok": False, "message": message}), 400
    return Response(image, mimetype="image/png", headers={"Cache-Control": "no-store"})


@app.get("/api/log")
def api_log():
    blocked = _connected_or_error()
    if blocked:
        return blocked
    return jsonify({"ok": True, "lines": core.read_log(request.args.get("lines", "200"))})


@app.post("/api/key")
def api_key():
    blocked = _connected_or_error()
    if blocked:
        return blocked
    result = core.send_key(str((request.get_json(silent=True) or {}).get("key", "")))
    return jsonify(result), (200 if result["ok"] else 400)


@app.get("/api/app/<package>")
def api_app_details(package):
    blocked = _connected_or_error()
    if blocked:
        return blocked
    result = core.app_details(package)
    return jsonify(result), (200 if result["ok"] else 400)


@app.post("/api/app/action")
def api_app_action():
    blocked = _connected_or_error()
    if blocked:
        return blocked
    payload = request.get_json(silent=True) or {}
    result = core.app_action(str(payload.get("package", "")), str(payload.get("action", "")),
                             confirm=bool(payload.get("confirm")))
    return jsonify(result), (200 if result["ok"] else 400)


@app.get("/api/launcher")
def api_launcher():
    blocked = _connected_or_error()
    if blocked:
        return blocked
    return jsonify({"ok": True, **core.launcher_options()})


@app.post("/api/launcher/set")
def api_launcher_set():
    blocked = _connected_or_error()
    if blocked:
        return blocked
    component = str((request.get_json(silent=True) or {}).get("component", ""))
    result = core.set_launcher(component)
    return jsonify(result), (200 if result["ok"] else 400)


@app.get("/api/tunables")
def api_tunables():
    blocked = _connected_or_error()
    if blocked:
        return blocked
    return jsonify({"ok": True, **core.tunable_values()})


@app.post("/api/tunables")
def api_tunable_set():
    blocked = _connected_or_error()
    if blocked:
        return blocked
    payload = request.get_json(silent=True) or {}
    result = core.set_tunable(str(payload.get("name", "")), payload.get("value", ""))
    return jsonify(result), (200 if result["ok"] else 400)


@app.post("/api/reboot")
def api_reboot():
    blocked = _connected_or_error()
    if blocked:
        return blocked
    if not (request.get_json(silent=True) or {}).get("confirm"):
        return jsonify({"ok": False, "message": "Reboot needs confirm=true."}), 400
    result = core.reboot()
    return jsonify(result), (200 if result["ok"] else 400)


def free_port(host, base):
    family = socket.AF_INET6 if ":" in host else socket.AF_INET
    for port in range(base, base + 10):
        with socket.socket(family, socket.SOCK_STREAM) as probe:
            probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                probe.bind((host, port))
            except OSError:
                continue
        return port
    raise SystemExit(f"No free port between {base} and {base + 9}.")


def main():
    # TOOLKIT_* let a container set these without editing the command line.
    parser = argparse.ArgumentParser(description="Run the Android TV Toolkit web interface.")
    parser.add_argument("--host", default=os.environ.get("TOOLKIT_HOST", "127.0.0.1"),
                        help="address to bind (default 127.0.0.1, this machine only)")
    parser.add_argument("--port", type=int, default=int(os.environ.get("TOOLKIT_PORT", "5000")),
                        help="port to start from if free (default 5000)")
    parser.add_argument("--no-browser", action="store_true",
                        default=bool(os.environ.get("TOOLKIT_NO_BROWSER")),
                        help="do not open a browser automatically")
    args = parser.parse_args()

    port = free_port(args.host, args.port)
    url = f"http://{'127.0.0.1' if args.host in ('0.0.0.0', '::') else args.host}:{port}/"
    print(f"Android TV Toolkit → {url}")
    print(f"Using adb: {core.ADB}")
    if not args.no_browser:
        threading.Timer(1.0, webbrowser.open, args=(url,)).start()
    app.run(host=args.host, port=port, debug=False, use_reloader=False)


if __name__ == "__main__":
    main()
