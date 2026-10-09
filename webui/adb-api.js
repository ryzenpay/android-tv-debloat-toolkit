/* Browser-side engine for the toolkit's own page.

This file replaces /static/api.js and nothing else: index.html, app.css and app.js stay the toolkit's
own, untouched. The seam is window.fetch — every call the page makes is still an ordinary
fetch("/api/…"), so req(), api() and all their callers keep working unchanged; only the answer comes
from ADB spoken inside this tab over the relay's byte pipe instead of from Flask. The TV therefore
only has to be reachable from the machine running the relay, never from wherever the page loaded.

Response bodies and status codes are ports of app.py + adb_core.py, not approximations: same keys,
same wording, same validators, same device-reported allow-lists.
*/

const $ = (selector) => document.querySelector(selector);

const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({
  "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));

let inFlight = 0;

function log(message, cls) {
  const line = document.createElement("div");
  if (cls) line.className = cls;
  line.textContent = new Date().toLocaleTimeString() + "  " + message;
  $("#log").prepend(line);
}

function busy(on) {
  inFlight = Math.max(0, inFlight + (on ? 1 : -1));
  $("#bar").classList.toggle("on", inFlight > 0);
}

function report(data, prefix, message) {
  log((data.ok ? "✓ " : "✗ ") + (prefix || "") + (message === undefined ? data.message : message),
    data.ok ? "ok" : "bad");
}

const fail = (message) => log("✗ " + message, "bad");

function requestInit(body) {
  if (body instanceof FormData) return { method:"POST", body };
  if (body) {
    return { method:"POST", headers:{ "Content-Type":"application/json" }, body:JSON.stringify(body) };
  }
  return { method:"GET" };
}

async function req(path, options, el) {
  if (el) el.dataset.busy = "1";
  busy(true);
  try {
    return await fetch(path, requestInit(options && options.body));
  } finally {
    busy(false);
    if (el) delete el.dataset.busy;
  }
}

async function api(path, body, el) {
  try {
    const response = await req(path, body === undefined ? null : { body }, el);
    return await response.json();
  } catch (error) {
    return { ok:false, message:"Request failed: " + error.message };
  }
}

const skeletons = (count) => Array.from({ length:count }, () => '<div class="sk"></div>').join("");

const fmt = (value, unit) => (value || value === 0) ? `${value}${unit || ""}` : "—";


/* The engine's own names live in one private scope. Both this file and app.js are classic scripts
   sharing the page's global scope, so a repeated top-level `const` is a SyntaxError that kills app.js
   before it renders anything — which is exactly how APP_ACTIONS once blanked the whole page. Only the
   names above (the api.js surface) stay global, because app.js calls them. */
(() => {


  const CDN = "https://cdn.jsdelivr.net/npm";
  const VERSION = "3.0.0-beta.3";
  const KEY_STORE = "adb-keys";
  const KEY_NAME = "this browser";

  let LIB = null, STREAM = null, CREDS = null, CLIENT = null;
  let link = null;   // { adb, close, target, sh }

  async function libs() {
    if (!LIB) {
      [LIB, STREAM, CREDS, CLIENT] = await Promise.all([
        import(`${CDN}/@yume-chan/adb@${VERSION}/+esm`),
        import(`${CDN}/@yume-chan/stream-extra@${VERSION}/+esm`),
        import(`${CDN}/@yume-chan/adb-credential-web@${VERSION}/+esm`),
        import("./adb-client.js"),
      ]);
    }
    return { lib:LIB, stream:STREAM, creds:CREDS, client:CLIENT };
  }

  function relayURL(target) {
    const meta = document.querySelector('meta[name="relay-token"]');
    const served = meta && meta.content && !meta.content.includes("__RELAY") ? meta.content : "";
    // The relay only serves this page to a request that already presented the token, so keeping what it
    // handed over is what makes a reload work without typing anything; the old key was never written.
    if (served) localStorage.setItem("relay-token", served);
    const token = served || localStorage.getItem("relay-token") || "";
    return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/adb/`
         + `${encodeURIComponent(target).replace(/%3A/gi, ":")}?token=${encodeURIComponent(token)}`;
  }

  const AUTH_HINT = "The TV only talks to computers it has authorised. Tap 'Always allow from this "
    + "computer' on the prompt on the TV screen; if no prompt appeared, the key it saved is gone — use "
    + "'Pair with a code' below with a fresh 6-digit code from the Wireless debugging screen.";
  const PAIR_HINT = "Android 11+, Google TV and Chromecast builds have no switch named 'ADB Debugging' "
    + "— it is Developer options → Wireless debugging. Turn that on, then use 'Pair with a code' below "
    + "with the address and 6-digit code from the 'Pair device with pairing code' screen. A TV that has "
    + "rebooted or slept also drops its wireless port and needs re-enabling.";

  /* The page's connect flow is a message plus an optional hint, so these are the only two failure
     shapes reported: unreachable through the relay, or reached but not authorised. */
  async function connectTo(ip, port) {
    if (!ipv4(ip)) {
      return { ok:false, message:"Invalid IP address. Enter a valid IPv4 address (e.g. 192.168.1.100)." };
    }
    const target = `${ip}:${port || "5555"}`;
    if (link) { try { link.close(); } catch { /* already gone */ } link = null; }
    let stage = "reach";
    try {
      const { lib, stream, creds, client } = await libs();
      const opened = await client.openAdb({
        lib, stream, url: relayURL(target),
        credentialManager: new creds.AdbWebCryptoCredentialManager(new creds.TangoLocalStorage(KEY_STORE), KEY_NAME),
        onEvent: (event) => {
          // waiting-for-tv fires as the public key leaves, i.e. when adbd raises the Allow dialog.
          if (event.type === "waiting-for-tv") {
            stage = "auth";
            log("You might have to authorize on the TV: accept “Allow USB debugging”.", "bad");
          } else if (event.type === "key-error") {
            log(`A stored key could not be read: ${event.message}`, "bad");
          }
        },
      });
      link = { ...opened, target, sh: client.shellFor(opened.adb) };
      log(`Connected to ${target}`, "ok");
      return { ok:true, message:`Connected to ${target}.` };
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      if (stage === "auth") return { ok:false, message:`The TV did not authorise this browser: ${message}`, hint:AUTH_HINT };
      return { ok:false, message:`Cannot reach ${target}: ${message}`, hint:PAIR_HINT };
    }
  }

  function requireLink() {
    if (!link) throw new Error("Not connected. Connect to your TV first.");
    return link;
  }

  /* ------------------------------------------------------------------ ported rules */

  const PACKAGE = /^[A-Za-z0-9_.]{1,128}$/;
  const COMPONENT = /^[A-Za-z0-9_.]{1,128}\/[A-Za-z0-9_.]{1,128}$/;
  const NUMBER = /^\d+(\.\d+)?$/;

  const KEYS = {
    back:4, home:3, recents:187, ok:23, menu:82, info:164, up:19, down:20, left:21, right:22,
    vol_up:24, vol_down:25, mute:91, play:126, pause:127, play_pause:85, rewind:168, forward:167,
    channel_up:166, channel_down:165, guide:172, settings:176, tv_input:178, hdmi_1:243, power:26,
  };

  const TUNABLES = {
    window_animation_scale:["global", "1.0"],
    transition_animation_scale:["global", "1.0"],
    animator_duration_scale:["global", "1.0"],
    font_scale:["system", "1.0"],
    stay_on_while_plugged_in:["global", "0"],
  };

  const APP_ACTIONS = {
    "force-stop":"am force-stop {pkg}",
    "clear-data":"pm clear {pkg}",
    "launch":"monkey -p {pkg} -c android.intent.category.LAUNCHER 1",
    "uninstall-updates":"pm uninstall-updates {pkg}",
    "uninstall":"pm uninstall {pkg}",
    "uninstall-user":"pm uninstall -k --user 0 {pkg}",
    "reinstall-keep-data":"cmd package install-existing --user 0 {pkg}",
  };
  const CONFIRM_ACTIONS = new Set(["clear-data", "uninstall-updates", "uninstall", "uninstall-user"]);

  function ipv4(text) {
    const parts = String(text || "").split(".");
    return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) < 256);
  }

  function clean(text) {
    return String(text || "").replace(/\r/g, "").trim();
  }

  /* Word-for-word port of adb_core._outcome, so a browser run and a server run read the same. */
  function outcome(stdout, stderr, rc) {
    const out = clean(stdout), err = clean(stderr);
    if (rc === 0 && /new state: disabled/i.test(out)) return [true, "Disabled"];
    if (rc === 0 && /success/i.test(out)) return [true, out || "Done"];
    if (/already/i.test(out) || /already/i.test(err)) return [true, "Already disabled"];
    if (/unknown package/i.test(out) || /unknown package/i.test(err)) return [true, "Not installed on this device"];
    if (rc !== 0) return [false, (err || out) || "Unknown error"];
    return [false, `Unexpected response — ${out}`];
  }

  const kv = (text, key) => {
    const match = text.match(new RegExp(`^@${key} (.*)$`, "m"));
    return match ? match[1].trim() : "";
  };

  /* adb_core._first_error, rule for rule: pm's own failure line rather than the stack trace under it,
     and the bare "Exception occurred while executing" header only when nothing more specific is there.
     A loose search here made this engine report a different line than the Python one for the same
     failed install. */
  function firstError(text) {
    const lines = String(text || "").split("\n").map((line) => line.trim()).filter((line) => line);
    return lines.find((line) => /^(Error:|Failure:|INSTALL)/.test(line))
      || lines.find((line) => line.includes("Error:") || line.includes("Failure:"))
      || lines[0] || "unknown error";
  }

  async function prop(name) {
    return clean(await requireLink().sh(`getprop ${name}`));
  }

  /* adb_core.device_info(): model, release and the target this browser is talking to. */
  async function deviceInfo() {
    const [model, android] = await Promise.all([
      prop("ro.product.model"), prop("ro.build.version.release"),
    ]);
    return { model, android, target: link.target };
  }

  async function disablePackage(pkg) {
    try {
      return outcome(await requireLink().sh(`pm disable-user --user 0 ${pkg}`), "", 0);
    } catch (error) {
      return outcome("", error && error.message ? error.message : String(error), 1);
    }
  }

  async function launcherOptions() {
    const sh = requireLink().sh;
    const [activities, roles] = await Promise.all([
      sh("cmd package query-activities -a android.intent.action.MAIN -c android.intent.category.HOME --brief"),
      sh("cmd role get-role-holders android.app.role.HOME 0"),
    ]);
    const options = [];
    for (const line of activities.split("\n")) {
      const text = clean(line);
      if (text.includes("/") && !text.includes(" ")) {
        options.push({ component: text, package: text.split("/")[0] });
      }
    }
    return { current: clean(roles), options };
  }

  /* adb_core._TELEMETRY verbatim: one round trip for identity, uptime, memory, storage, display,
     network and launcher. The quoting is the device shell's, not decoration. */
  const TELEMETRY = [
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
  ].join("; ");

  const whole = (value) => {
    const digits = String(value || "0").match(/\d+/);
    return digits ? parseInt(digits[0], 10) : 0;
  };

  /* Port of adb_core.telemetry(): the same keys, the same units, the same rounding. */
  function telemetryFrom(raw, props) {
    const disk = (raw.disk || "").split(/\s+/).filter(Boolean);
    const sizes = (raw.size || "").split(/\s+/).filter((part) => part.includes("x"));
    return {
      serial: props.serial, build: props.build, abi: props.abi,
      sdk: props.sdk, manufacturer: props.manufacturer, build_type: props.type,
      uptime_hours: Math.round(whole(raw.up) / 3600 * 10) / 10,
      memory_mb: Math.floor(whole(raw.mem_total) / 1024),
      memory_free_mb: Math.floor(whole(raw.mem_avail) / 1024),
      load: raw.load || "",
      storage: disk.length === 4 ? {
        total_mb: Math.floor(whole(disk[0]) / 1024), used_mb: Math.floor(whole(disk[1]) / 1024),
        free_mb: Math.floor(whole(disk[2]) / 1024), percent: disk[3],
      } : {},
      resolution: sizes.length ? sizes[sizes.length - 1] : "",
      physical_resolution: sizes.length ? sizes[0] : "",
      density: (raw.density || "").replace("Physical density: ", "").trim(),
      ip: raw.ip || "",
      launcher: raw.home || "",
      user: raw.user || "",
    };
  }

  /* ------------------------------------------------------------------ the routes */

  const NOT_PORTED = (reason) => ({ connected:false, handle: () => ({
    body:{ ok:false, message:`This action still needs the server-side app: ${reason}` }, status:409,
  }) });

  async function manifest() {
    // The cache sits next to the page, so this is a same-origin read of a file the relay serves.
    const response = await fetch("/apks/index.json", { cache:"no-store" }).catch(() => null);
    if (!response || !response.ok) return { abi:"", files:[] };
    const data = await response.json().catch(() => null);
    return { abi: (data && data.abi) || "", files: Array.isArray(data && data.files) ? data.files : [] };
  }

  /* One route every APK takes to the TV: /data/local/tmp, never /sdcard — pm install is a read by
     system_server, which Android 11+ denies the fuse context, answering with SELinux denials instead
     of an APK. adb_core.install_apk runs the same three steps through the adb binary. */
  async function pushAndInstall(name, blob, mb = null) {
    const remote = `/data/local/tmp/${name}`;
    try {
      await requireLink().adb.sync.write({ path: remote, mode: 0o644, readable: blob.stream() });
    } catch (error) {
      return { body:{ ok:false, message:`Push failed: ${error && error.message || error}` }, status:400 };
    }
    const out = clean(await requireLink().sh(`pm install -r ${remote}`));
    await requireLink().sh(`rm -f ${remote}`).catch(() => { /* the file is harmless */ });
    const ok = /success/i.test(out);
    const size = mb === null ? "" : ` (${mb.toFixed(1)} MB).`;
    return { body:{ ok, message: ok ? `Installed ${name}.${size}` : `Install failed: ${firstError(out)}` },
      status: ok ? 200 : 400 };
  }

  async function screenshot() {
    // Raw bytes: createSocketAndWait decodes to text and would destroy the PNG.
    const socket = await requireLink().adb.createSocket("exec:screencap -p");
    const parts = [];
    for await (const chunk of socket.readable) parts.push(chunk instanceof Uint8Array ? chunk : chunk.toArray());
    const image = new Blob(parts, { type:"image/png" });
    const head = new Uint8Array(await image.slice(0, 4).arrayBuffer());
    if (image.size < 1024 || head[0] !== 0x89 || head[1] !== 0x50) {
      return json({ ok:false, message:"The device returned no image data." }, 400);
    }
    return new Response(image, { status:200, headers:{ "Content-Type":"image/png", "Cache-Control":"no-store" } });
  }

  const routes = {
    "/api/state": { connected:false, handle: async () => ({ body:{
      connected: !!link, target: link ? link.target : "", adb: "in this browser (no adb binary)",
      device: link ? await deviceInfo() : null,
    } }) },

    "/api/connect": { connected:false, handle: (body) => ({
      pending: connectTo(String(body.ip || "").trim(), String(body.port || "5555").trim() || "5555"),
    }) },

    "/api/disconnect": { connected:false, handle: async () => {
      const target = link ? link.target : "";
      if (link) { try { link.close(); } catch { /* already closed */ } link = null; }
      return { body:{ ok:true, message: target ? `Disconnected from ${target}.` : "Not connected." } };
    } },

    "/api/discover": NOT_PORTED("mDNS discovery belongs to the machine that runs adb and a web page "
      + "cannot query the local network. Type the TV's address instead; the relay is the only thing here "
      + "that can open a socket and it refuses hostnames on purpose."),

    "/api/pair": NOT_PORTED("pairing with a 6-digit code is a SPAKE2/TLS handshake the browser ADB "
      + "library does not implement. It is not needed here: this browser generates its own key and the "
      + "TV approves it once at the Allow dialog, after which the address above is all you type."),

    "/api/apks": { connected:false, handle: async () => {
      const cache = await manifest();
      return { body:{ ok:true, abi:cache.abi, files:cache.files } };
    } },

    "/api/install": { connected:true, handle: async (body) => {
      const safe = (name) => String(name || "app.apk").replace(/[^A-Za-z0-9._-]/g, "_").slice(-120) || "app.apk";
      const file = body.form && body.form.get("file");
      if (file && typeof file.arrayBuffer === "function") {
        return pushAndInstall(safe(file.name), new Blob([await file.arrayBuffer()]));
      }

      const wanted = String(body.cached || "").trim();
      if (wanted) {
        /* Only a file this checkout's own manifest lists, by exact name — no path, no host, nothing to
           traverse. app.py applies the same rule to the copy it reads off disk. */
        const cache = await manifest();
        const row = cache.files.find((entry) => entry.file === wanted);
        if (!row) return { body:{ ok:false, message:`${wanted} is not one of the APKs cached here.` }, status:400 };
        const response = await fetch(`/apks/${encodeURIComponent(row.file)}`, { cache:"no-store" });
        if (!response.ok) {
          return { body:{ ok:false,
            message:`${row.file} is listed in apks/index.json but the file is not here.` }, status:400 };
        }
        return pushAndInstall(safe(row.file), await response.blob(), (row.bytes || 0) / 1048576);
      }

      if (!String(body.url || "").trim()) return { body:{ ok:false, message:"No APK selected." }, status:400 };
      return { body:{ ok:false, message:"Installing from a URL has to fetch the file outside the "
        + "browser — GitHub's file host sends no cross-origin headers, so this page cannot download it. "
        + "Choose a file from this computer, or install one of the copies cached in this checkout." }, status:400 };
    } },

    "/api/inventory": { connected:true, handle: async () => {
      const { detectPackages } = await import("./inventory.js");
      const apps = await detectPackages(requireLink().sh);
      return { body:{ ok:true, device: await deviceInfo(), apps, counts:{
        total: apps.length,
        bloat: apps.filter((row) => row.verdict === "bloat" && row.state === "enabled").length,
        disabled: apps.filter((row) => row.state === "disabled").length,
      } } };
    } },

    "/api/user-apps": { connected:true, handle: async () => {
      /* `pm list packages -3` is the device's own answer to "installed after the factory image" — the same
         command adb_core.user_apps runs, so both engines report the identical set. */
      const packages = (await requireLink().sh("pm list packages -3")).split("\n")
        .map((line) => clean(line))
        .filter((line) => line.startsWith("package:"))
        .map((line) => line.slice("package:".length).trim())
        .sort();
      return { body:{ ok:true, packages } };
    } },

    "/api/device": { connected:true, handle: async () => {
      const sh = requireLink().sh;
      const raw = {};
      for (const line of (await sh(TELEMETRY)).split("\n")) {
        if (line.startsWith("@") && line.includes(" ")) {
          const [key, ...rest] = line.slice(1).split(" ");
          raw[key] = rest.join(" ").trim();
        }
      }
      const [serial, build, abi, sdk, manufacturer, type] = await Promise.all([
        prop("ro.serialno"), prop("ro.build.display.id"), prop("ro.product.cpu.abi"),
        prop("ro.build.version.sdk"), prop("ro.product.manufacturer"), prop("ro.build.type"),
      ]);
      return { body:{ ok:true, device: await deviceInfo(),
        telemetry: telemetryFrom(raw, { serial, build, abi, sdk, manufacturer, type }) } };
    } },

    "/api/log": { connected:true, handle: async (body, params) => {
      let count = parseInt(params.get("lines") || body.lines || "200", 10);
      if (isNaN(count)) count = 200;
      count = Math.max(10, Math.min(count, 2000));
      const text = await requireLink().sh(`logcat -d -t ${count}`);
      return { body:{ ok:true, lines: text.split("\n").map((line) => line.replace(/\r$/, "")).filter(Boolean) } };
    } },

    "/api/screenshot": { connected:true, handle: () => ({ raw: screenshot() }) },

    "/api/key": { connected:true, handle: async (body) => {
      const key = String(body.key || "").trim().toLowerCase();
      if (!(key in KEYS)) {
        return { body:{ ok:false, message:`Unknown key '${body.key}'. Known: ${Object.keys(KEYS).sort().join(", ")}.` }, status:400 };
      }
      try {
        await requireLink().sh(`input keyevent ${KEYS[key]}`);
        return { body:{ ok:true, message:`Sent ${body.key}.` } };
      } catch (error) {
        return { body:{ ok:false, message: clean(error && error.message) || "input failed" }, status:400 };
      }
    } },

    "/api/tunables": { connected:true, handle: async (body, params, method) => {
      const sh = requireLink().sh;
      if (method !== "POST") {
        const text = await sh(Object.entries(TUNABLES)
          .map(([name, [table]]) => `echo "@${name} $(settings get ${table} ${name})"`).join("; "));
        const values = {};
        for (const [name, [, factory]] of Object.entries(TUNABLES)) {
          values[name] = { value: kv(text, name) || "null", factory };
        }
        return { body:{ ok:true, values } };
      }
      const name = String(body.name || "");
      const spec = TUNABLES[name];
      if (!spec) return { body:{ ok:false, message:`'${name}' is not adjustable here.` }, status:400 };
      const value = String(body.value ?? "").trim();
      if (!NUMBER.test(value)) return { body:{ ok:false, message:"Value must be a number." }, status:400 };
      try {
        await sh(`settings put ${spec[0]} ${name} ${value}`);
        return { body:{ ok:true, message:`${name} = ${value}` } };
      } catch (error) {
        return { body:{ ok:false, message: clean(error && error.message) || "settings put failed" }, status:400 };
      }
    } },

    "/api/app/action": { connected:true, handle: async (body) => {
      const pkg = String(body.package || "");
      const action = String(body.action || "");
      if (!(action in APP_ACTIONS)) {
        return { body:{ ok:false, message:`Unknown action '${action}'. Known: ${Object.keys(APP_ACTIONS).sort().join(", ")}.` }, status:400 };
      }
      if (!PACKAGE.test(pkg)) return { body:{ ok:false, message:"Invalid package name." }, status:400 };
      if (CONFIRM_ACTIONS.has(action) && !body.confirm) {
        return { body:{ ok:false, message:`'${action}' needs confirm=true.` }, status:400 };
      }
      const sh = requireLink().sh;
      if (!clean(await sh(`pm path ${pkg}`))) {
        return { body:{ ok:false, message:`${pkg} is not installed on this device.` }, status:400 };
      }
      let output = "", rc = 0;
      try { output = await sh(APP_ACTIONS[action].replace("{pkg}", pkg)); }
      catch (error) { output = error && error.message ? error.message : String(error); rc = 1; }
      let [ok, detail] = outcome(output, rc ? output : "", rc);
      if (!ok && /installed for user: 0/i.test(output)) {
        // install-existing on a package the user already has is a no-op, not a failure.
        ok = true;
        detail = `${pkg} is already installed for user 0.`;
      }
      if (!ok && /delete_failed/i.test(output)) {
        // Every system app answers a real uninstall this way; the per-user one is the route that works.
        detail = "System app — the partition holds it, so a full uninstall is refused. "
          + "Use Uninstall for user 0 (Re-enable for user 0 puts it back) or Disable instead.";
      }
      if (ok && action === "uninstall-user") {
        detail = `Removed ${pkg} for user 0. Re-enable for user 0 puts it back.`;
      }
      return { body:{ ok, message: detail || `${action} applied to ${pkg}.` }, status: ok ? 200 : 400 };
    } },

    "/api/launcher": { connected:true, handle: async () => ({ body:{ ok:true, ...await launcherOptions() } }) },

    "/api/launcher/set": { connected:true, handle: async (body) => {
      const component = String(body.component || "").trim();
      if (!COMPONENT.test(component)) return { body:{ ok:false, message:"Invalid component name." }, status:400 };
      const { options } = await launcherOptions();
      if (!options.some((option) => option.component === component)) {
        return { body:{ ok:false,
          message:`${component} is not a launcher this device offers — pick one from the list.` }, status:400 };
      }
      let output = "", rc = 0;
      try { output = await requireLink().sh(`cmd package set-home-activity ${component}`); }
      catch (error) { output = error && error.message ? error.message : String(error); rc = 1; }
      return { body:{ ok: rc === 0,
        message: rc === 0 ? `Default launcher set to ${component}.` : (clean(output) || "set-home-activity failed") },
        status: rc === 0 ? 200 : 400 };
    } },

    "/api/launcher/disable": { connected:true, handle: async () => {
      const [ok, detail] = await disablePackage("com.google.android.tvlauncher");
      return { body:{ ok, message: detail || "No output received." } };
    } },

    "/api/debloat": { connected:true, handle: async (body) => {
      const packages = body.packages;
      if (!Array.isArray(packages) || !packages.length) {
        return { body:{ ok:false, message:"No apps selected." }, status:400 };
      }
      const { detectPackages } = await import("./inventory.js");
      const detected = Object.fromEntries((await detectPackages(requireLink().sh)).map((row) => [row.package, row]));
      const results = [];
      for (const pkg of packages) {
        if (typeof pkg !== "string" || !PACKAGE.test(pkg)) {
          results.push({ label: pkg, package: pkg, ok:false, detail:"Rejected — not a package name" });
          continue;
        }
        const row = detected[pkg];
        if (!row) {
          results.push({ label: pkg, package: pkg, ok:true, detail:"Not installed on this device" });
          continue;
        }
        if ((row.risk === "core" || row.risk === "overlay") && !body.confirm_core) {
          results.push({ label: pkg, package: pkg, ok:false, detail:"Refused — " + row.reasons.join(", ") });
          continue;
        }
        const [ok, detail] = await disablePackage(pkg);
        results.push({ label: row.label, package: pkg, ok, detail });
      }
      const done = results.filter((row) => row.ok).length;
      return { body:{ ok: done === results.length, results, message:`${done} of ${results.length} handled.` } };
    } },

    "/api/restore": { connected:true, handle: async (body) => {
      const packages = body.packages;
      if (!Array.isArray(packages) || !packages.length) {
        return { body:{ ok:false, message:"Nothing selected." }, status:400 };
      }
      const results = [];
      for (const pkg of packages) {
        if (typeof pkg !== "string" || !PACKAGE.test(pkg)) {
          results.push({ package: pkg, ok:false, detail:"Rejected — not a package name" });
          continue;
        }
        let text = "", rc = 0;
        try { text = await requireLink().sh(`pm enable ${pkg}`); }
        catch (error) { text = error && error.message ? error.message : String(error); rc = 1; }
        const combined = text.toLowerCase();
        let detail;
        if (rc === 0 && combined.includes("enabled")) detail = "Enabled";
        else if (combined.includes("already")) detail = "Already enabled";
        else detail = clean(text) || "Unknown error";
        results.push({ package: pkg, ok: rc === 0, detail });
      }
      const done = results.filter((row) => row.ok).length;
      return { body:{ ok: done === results.length, results, message:`${done} of ${results.length} re-enabled.` } };
    } },

    "/api/reboot": { connected:true, handle: async (body) => {
      if (!body.confirm) return { body:{ ok:false, message:"Reboot needs confirm=true." }, status:400 };
      // adb's own reboot is the `reboot:` service with an empty argument.
      await requireLink().adb.createSocket("reboot:");
      return { body:{ ok:true, message:"Rebooting — ADB drops for a minute and Wireless debugging may need "
        + "re-enabling on the TV." } };
    } },
  };

  /* Port of adb_core.app_details(): same grep, same split-APK summing, same null for unknown data. */
  async function appDetails(pkg) {
    if (!PACKAGE.test(pkg)) return json({ ok:false, message:"Invalid package name." }, 400);
    const sh = requireLink().sh;
    const listing = await sh(`dumpsys package ${pkg} | grep -E `
      + `'versionCode=|versionName=|installerPackageName|firstInstallTime`
      + `|lastUpdateTime|primaryCpuAbi' | head -8`);
    const info = {};
    for (const line of listing.split("\n")) {
      for (const field of ["versionName", "installerPackageName", "firstInstallTime", "lastUpdateTime", "primaryCpuAbi"]) {
        if (line.includes(field + "=")) {
          const value = line.split(field + "=", 2)[1].trim();
          if (info[field] === undefined) info[field] = value;
        }
      }
      if (line.includes("versionCode=")) {
        const head = line.split("versionCode=", 2)[1].split(/\s+/).filter(Boolean);
        if (info.versionCode === undefined) info.versionCode = head[0];
        for (const part of head.slice(1)) {
          if (/^(minSdk|targetSdk)=/.test(part)) {
            const [key, value] = [part.split("=")[0], part.split("=").slice(1).join("=")];
            if (info[key] === undefined) info[key] = value;
          }
        }
      }
    }
    let apkKb = 0;
    for (const line of (await sh(`pm path ${pkg}`)).split("\n")) {
      if (line.startsWith("package:")) {
        const size = clean(await sh(`du -k ${line.slice(8)}`)).split(/\s+/);
        if (size.length && /^\d+$/.test(size[0])) apkKb += parseInt(size[0], 10);
      }
    }
    const data = clean(await sh(`du -sk /data/data/${pkg} 2>/dev/null`)).split(/\s+/);
    const permissions = (await sh(`dumpsys package ${pkg} | sed -n '/runtime permissions:/,$p' | grep -m 40 'granted='`))
      .split("\n").filter((line) => line.includes("granted=")).map((line) => line.trim());
    return json({
      ok:true, package: pkg, info, apk_kb: apkKb,
      data_kb: data.length && /^\d+$/.test(data[0]) ? parseInt(data[0], 10) : null,
      permissions,
    });
  }

  /* ------------------------------------------------------------------ the seam */

  function json(payload, status) {
    return new Response(JSON.stringify(payload), {
      status: status || 200,
      headers:{ "Content-Type":"application/json" },
    });
  }

  /* Exact routes win; /api/app/<package> is the one parameterised path, and /api/app/action is exact. */
  function lookup(path) {
    if (routes[path]) return [routes[path], ""];
    if (path.startsWith("/api/app/")) return [{ connected:true, handle:null }, decodeURIComponent(path.slice(9))];
    return [null, ""];
  }

  async function dispatch(url, init) {
    const [path, query] = url.split("?");
    const method = (init && init.method ? init.method : "GET").toUpperCase();
    let body = {};
    if (typeof (init && init.body) === "string") {
      try { body = JSON.parse(init.body); } catch { body = {}; }
    } else if (init && typeof FormData !== "undefined" && init.body instanceof FormData) {
      body = { form: init.body };
    }
    const [route, arg] = lookup(path);
    if (!route) return json({ ok:false, message:`${path} is not wired to the browser engine.` }, 404);
    if (route.connected && !link) return json({ ok:false, message:"Not connected. Connect to your TV first." }, 409);
    try {
      if (arg) return await appDetails(arg);
      const result = await route.handle(body, new URLSearchParams(query || ""), method);
      if (result.raw) return await result.raw;
      if (result.pending) return json(await result.pending);
      return json(result.body, result.status || 200);
    } catch (error) {
      return json({ ok:false, message: error && error.message ? error.message : String(error) }, 400);
    }
  }

  const nativeFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    const url = typeof input === "string" ? input : (input && input.url) || "";
    if (url.startsWith("/api/")) return dispatch(url, init);
    return nativeFetch(input, init);
  };

  /* A ?connect= link fills the address fields and stops there — the same rule a discovered row follows in
     static/app.js. A link opened from a chat used to open a socket the instant the page loaded, with no
     click behind it, and the token and origin were already satisfied because the relay served the page.
     The toolkit's form is rendered by app.js after this module runs, so retry until the field is there. */
  const wanted = new URLSearchParams(location.search).get("connect");
  if (wanted) {
    const [ip, port] = wanted.split(":");
    const address = port ? `${ip}:${port}` : ip;
    let tries = 0;
    const fill = () => {
      if ($("#target")) { $("#target").value = address; return; }
      if ($("#ip")) {
        $("#ip").value = ip;
        $("#port").value = port || "5555";
        if ($("#log")) log(`Filled ${address} from the link — press Connect when you are ready.`, "note");
        return;
      }
      if (++tries < 50) setTimeout(fill, 100);
    };
    fill();
  }

  window.engineConnect = (ip, port) => connectTo(ip, port);
  window.engineConnected = () => !!link;
})();
