"""Android TV Toolkit — Flask web UI. Run: python app.py"""
import argparse
import os
import socket
import tempfile
import threading
import webbrowser

from flask import Flask, jsonify, render_template, request
from werkzeug.utils import secure_filename

import adb_core as core

app = Flask(__name__)


def _connected_or_error():
    if core.state.connected and core.reconnect_check():
        return None
    return jsonify({"ok": False, "message": "Not connected. Connect to your TV first."}), 409


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


@app.get("/api/catalog")
def api_catalog():
    config = core.load_config()
    return jsonify({
        "last_ip": config.get("last_ip", ""),
        "last_port": config.get("last_port", "5555"),
        "last_pair_port": config.get("last_pair_port", ""),
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
    if not upload or not upload.filename:
        return jsonify({"ok": False, "message": "No APK selected."}), 400
    name = secure_filename(upload.filename) or "app.apk"
    handle, path = tempfile.mkstemp(suffix=".apk")
    os.close(handle)
    try:
        upload.save(path)
        result = core.install_apk(path)
    finally:
        try:
            os.remove(path)
        except OSError:
            pass
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
