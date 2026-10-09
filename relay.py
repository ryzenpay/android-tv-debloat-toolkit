"""Local relay for browser-side ADB: a byte pipe between a WebSocket and the TV.

The page speaks the ADB protocol itself; this process exists only because a browser cannot
open a TCP socket. It parses no ADB bytes and stores nothing.

    python relay.py                      # prints the URL and a generated token
    open http://127.0.0.1:9503/

Endpoints:
    GET  /                       the page (served from ./webui) — needs ?token=
    GET  /toolkit                the toolkit page wired to the browser engine — needs ?token=
    WS   /adb/<ip>:<port>        raw bidirectional bytes to that address

Refusals are deliberate and are not only about DNS: an IP literal is required (no hostname, so nothing
pivots through a name), and the address itself has to name a remote machine — loopback and link-local are
refused because this socket would otherwise be one hop from the adb server on its own host, which holds the
owner's authorised session, and from the cloud metadata address. The TV lives on a private range, so private
addresses stay dialable; --allow-loopback is there for an emulator running on this host.
"""
import argparse
import asyncio
import ipaddress
import re
import secrets
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from websockets.asyncio.server import serve
from websockets.datastructures import Headers
from websockets.exceptions import ConnectionClosed
from websockets.http11 import Response

WEBUI = Path(__file__).with_name("webui")
MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".apk": "application/vnd.android.package-archive",
}
TARGET = re.compile(r"^/adb/(?P<target>[^\s?]+)$")
TOKEN_PLACEHOLDER = b"__RELAY_TOKEN__"
CHUNK = 64 * 1024

# Set from --allow-loopback in main(); read by handle(), which sits outside main's closure.
ALLOW_LOOPBACK = False

# This page can drive a device, so it must never be drivable from inside somebody else's page: a framed
# copy issues requests the relay cannot tell from the real thing.
SECURITY = [("Content-Security-Policy", "frame-ancestors 'none'"),
            ("X-Content-Type-Options", "nosniff"),
            ("Cache-Control", "no-store")]


def reply(status, reason, headers, body=b""):
    return Response(status, reason, Headers(headers), body)


def not_found(*_):
    return reply(404, "Not Found", [("Content-Type", "text/plain")] + SECURITY, b"Not found\n")


def page_locked():
    return reply(401, "Unauthorized", [("Content-Type", "text/plain")] + SECURITY,
                 b"This page is served only to a request that presents the token, because it carries it.\n"
                 b"Open the address relay.py printed -- it ends in ?token=... -- once, and the page keeps it.\n")


SHELL = WEBUI.parent / "templates" / "index.html"
# The toolkit's own page and markup, untouched except that the server-side transport is swapped for the
# browser engine. app.css, app.js and index.html stay single-sourced in the repo; nothing is forked.
SHELL_REWRITES = [
    (b'<script src="/static/api.js"></script>', b'<script src="./adb-api.js"></script>'),
    (b"</head>", b'<meta name="relay-token" content="' + TOKEN_PLACEHOLDER + b'">\n</head>'),
]


def shell(token):
    """Serve the real toolkit page wired to the browser engine, at /toolkit."""
    if not SHELL.is_file():
        return not_found()
    body = SHELL.read_bytes()
    for old, new in SHELL_REWRITES:
        body = body.replace(old, new)
    body = body.replace(TOKEN_PLACEHOLDER, token.encode())
    return reply(200, "OK", [("Content-Type", MIME[".html"])] + SECURITY, body)


def static(path, token="", permitted=True):
    """Serve the page and its assets, refusing anything that resolves outside its own root.

    /static/ maps to the repo's static/ directory, so the toolkit's real app.css and app.js are served
    from one place instead of forked into webui/. /apks/ maps to the APKs refresh_apks.py cached: the
    browser cannot read them off GitHub (that host sends no cross-origin headers), so they come from here.

    Only the HTML carries the token, so only the HTML is withheld from a request that has not presented
    one: an unauthenticated GET used to return the secret that unlocks the dial.
    """
    name = path.split("?")[0].rstrip("/") or "/"
    if name == "/toolkit":
        return shell(token) if permitted else page_locked()
    if name in ("/", "/gateway") or name.endswith("/index.html"):
        # The connect screen is the front door: it authorises the browser, then hands over to /toolkit.
        name = "/index.html"
    roots = {"/static/": WEBUI.parent / "static", "/apks/": WEBUI.parent / "apks"}
    for prefix, root in roots.items():
        if name.startswith(prefix):
            candidate = root / name[len(prefix):]
            break
    else:
        root, candidate = WEBUI, WEBUI / name.lstrip("/")
    candidate = candidate.resolve()
    if not candidate.is_relative_to(root.resolve()) or not candidate.is_file():
        return not_found()
    body = candidate.read_bytes()
    if candidate.suffix == ".html":
        if not permitted:
            return page_locked()
        body = body.replace(TOKEN_PLACEHOLDER, token.encode())
    kind = MIME.get(candidate.suffix, "application/octet-stream")
    return reply(200, "OK", [("Content-Type", kind)] + SECURITY, body)


def target_of(path, allow_loopback=False):
    """Return (address, port) when the path names an address this relay may dial.

    Shapes: /adb/192.168.5.107:5555, /adb/192.168.5.107 (port 5555), /adb/[fe80::1]:5555.

    The address has to name some machine other than this one. Loopback is where the adb server lives — it
    holds the TV's authorised session, so a socket that could reach it is not a device connection — and
    link-local is where 169.254.169.254 lives. The TV itself is on a private range, so is_private must stay
    dialable. A scoped address (fe80::1%eth0) is refused rather than stripped of its zone and guessed at.
    """
    match = TARGET.match(path.split("?")[0])
    if not match:
        return None
    target = match.group("target")
    host, sep, port_text = target.rpartition(":")
    if not sep or not port_text.isdigit():
        host, port = target, 5555
    else:
        host, port = host, int(port_text)
    try:
        address = ipaddress.ip_address(host.strip("[]"))
    except ValueError:
        return None  # hostnames are refused on purpose
    mapped = getattr(address, "ipv4_mapped", None)
    if mapped:
        # ::ffff:127.0.0.1 is this machine wearing an IPv6 spelling; judge the address it names.
        address = mapped
    if address.is_loopback and not allow_loopback:
        return None
    if address.is_link_local or address.is_multicast or address.is_unspecified or address.is_reserved:
        return None
    if not 0 < port < 65536:
        return None
    return (address, port)


def authorized(request, token, origins):
    """A browser sends Origin and cannot set a header on a WebSocket, so the token rides in the query."""
    origin = request.headers.get("Origin") or ""
    if origin and origin not in origins:
        return f"origin {origin} is not allowed"
    if token and (request.headers.get("Authorization") != f"Bearer {token}"):
        if parse_qs(urlparse(request.path).query).get("token", [""])[0] != token:
            return "missing or wrong token"
    return ""


async def pump_ws_to_tcp(websocket, writer):
    async for chunk in websocket:
        writer.write(chunk)
        await writer.drain()


async def pump_tcp_to_ws(websocket, reader):
    while True:
        chunk = await reader.read(CHUNK)
        if not chunk:
            return
        await websocket.send(chunk)


async def handle(websocket):
    request = websocket.request
    dialed = target_of(request.path, ALLOW_LOOPBACK)
    if dialed is None:
        await websocket.close(code=1008, reason="that address may not be dialed")
        return
    host, port = dialed
    origin = request.headers.get("Origin") or "(no origin)"
    print(f"[adb] {origin} -> {host}:{port}")
    try:
        reader, writer = await asyncio.wait_for(asyncio.open_connection(str(host), port), timeout=8)
    except (OSError, asyncio.TimeoutError) as exc:
        print(f"[adb] cannot reach {host}:{port}: {exc}")
        await websocket.close(code=1011, reason="cannot reach device")
        return
    print(f"[adb] connected {host}:{port}")
    legs = [asyncio.create_task(pump_ws_to_tcp(websocket, writer)),
            asyncio.create_task(pump_tcp_to_ws(websocket, reader))]
    try:
        await asyncio.wait(legs, return_when=asyncio.FIRST_COMPLETED)
    except ConnectionClosed:
        pass
    finally:
        for leg in legs:
            leg.cancel()
        writer.close()
        print(f"[adb] closed {host}:{port}")


def main():
    parser = argparse.ArgumentParser(description="Byte relay between a browser page and an ADB device.")
    parser.add_argument("--host", default="127.0.0.1", help="bind address (default 127.0.0.1; the page needs no other)")
    parser.add_argument("--port", type=int, default=9503)
    parser.add_argument("--token", default="", help="shared secret the page must present (default: generate one)")
    parser.add_argument("--no-token", action="store_true",
                        help="skip the secret; safe only on a loopback bind, and even then any process on this "
                             "machine may dial out through the relay (a browser page is still origin-gated)")
    parser.add_argument("--allow-origin", action="append", default=[],
                        help="page origin allowed to connect (repeatable), e.g. https://ryzenpay.github.io")
    parser.add_argument("--allow-loopback", action="store_true",
                        help="also let the relay dial 127.0.0.1 (an emulator on this host); by default it may "
                             "not, because this host's adb server holds your TV's authorised session")
    args = parser.parse_args()

    global ALLOW_LOOPBACK
    ALLOW_LOOPBACK = args.allow_loopback

    token = "" if args.no_token else (args.token or secrets.token_urlsafe(16))
    origins = set(args.allow_origin) | {f"http://127.0.0.1:{args.port}", f"http://localhost:{args.port}"}

    async def gate(connection, request):
        # Authorise first, then serve: the page carries the token, so answering an unauthenticated GET with
        # it handed the only credential in front of the dial to any process that could open a socket here.
        reason = authorized(request, token, origins)
        if "websocket" not in (request.headers.get("Upgrade") or "").lower():
            return static(request.path, token, permitted=not reason)
        if target_of(request.path, args.allow_loopback) is None:
            return not_found()
        if reason:
            return reply(403, "Forbidden", [("Content-Type", "text/plain")] + SECURITY, f"{reason}\n".encode())
        return None

    async def run():
        async with serve(handle, args.host, args.port, origins=None, compression=None,
                         max_size=4 * 1024 * 1024, process_request=gate, ping_interval=20):
            print(f"Relay listening on http://{args.host}:{args.port}/")
            shown = "127.0.0.1" if args.host in ("0.0.0.0", "::") else args.host
            print(f"  page    http://{shown}:{args.port}/?token={token}")
            print(f"  toolkit http://{shown}:{args.port}/toolkit?token={token}")
            print(f"  token  {token or 'none (--no-token): any local process may dial out through this relay'}")
            print(f"  origins {', '.join(sorted(origins))}")
            refused = "link-local, multicast, hostnames" if args.allow_loopback else \
                "loopback, link-local, multicast, hostnames"
            print(f"  dials   IP literals only; refused: {refused}")
            await asyncio.Future()

    try:
        asyncio.run(run())
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
