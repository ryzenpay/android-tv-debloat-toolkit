/* Page logic: renders each panel from the API in api.js and wires the controls. */

let apps = [];
let filter = "bloat";
let connected = false;
let state = { target:"" };
let forcePair = false;

/* ---------- remembered TV (this browser only) ----------
   The server keeps no state about which TV you use: it is often a throwaway container,
   and the address is yours, not the container's. Nothing is saved until a connect or
   pair with those values actually succeeded. */

const TV_KEY = "toolkit.tv";

function savedTV() {
  try {
    return JSON.parse(localStorage.getItem(TV_KEY)) || {};
  } catch (error) {
    return {};                     // storage blocked (private mode) or hand-edited junk
  }
}

function rememberTV(values) {
  try {
    localStorage.setItem(TV_KEY, JSON.stringify({ ...savedTV(), ...values }));
  } catch (error) {
    log("Could not save the TV address in this browser: " + error.message, "note");
  }
}

function forgetTV() {
  localStorage.removeItem(TV_KEY);
  log("Forgot the saved TV — nothing is remembered in this browser.", "muted");
  renderConnection();
}

/* ---------- connection card ---------- */

function field(id, labelText, value, placeholder, size) {
  return `<label class="f"><span>${esc(labelText)}</span><input type="text" id="${id}"
    value="${esc(value || "")}" placeholder="${esc(placeholder || "")}" size="${size || 14}"></label>`;
}

function connectForm() {
  const saved = savedTV();
  const forget = saved.ip ? `<button class="ghost mini" id="forget-btn">
      <span class="lbl">Forget ${esc(saved.ip)}</span></button>` : "";
  return `<h2>Connect to TV</h2>
    <p class="hint">The setting is named differently depending on the TV generation — use whichever your TV shows.</p>
    <div class="paths">
      <div class="path"><b>Android 11+, Google TV, Chromecast, Onn</b>
        Settings → Device Preferences → Developer options → <b>Wireless debugging</b>. There is no switch called
        "ADB debugging" on these builds. Turn it on, open <b>Pair device with pairing code</b>, then use the
        pairing form below with the IP, pairing port and 6-digit code from that screen.</div>
      <div class="path"><b>Older Android TV builds</b>
        Settings → Device Preferences → Developer options → <b>ADB debugging</b> ON, then connect below with the
        TV's IP address (port 5555). TV and PC must be on the same network.</div>
    </div>
    <div class="row">
      ${field("ip","IP address",saved.ip,"192.168.1.",16)}
      ${field("port","Port",saved.port || "5555","5555",7)}
      <button id="connect-btn"><span class="lbl">Connect</span></button>
      ${forget}
    </div>
    <details id="pair-details" ${forcePair ? "open" : ""}>
      <summary>Pair with a code (Android 11+ / Google TV / Chromecast)</summary>
      <div class="row">
        ${field("p_ip","TV IP",saved.ip,"192.168.1.",16)}
        ${field("p_port","Pairing port",saved.pairPort,"37000",7)}
        ${field("p_code","Pairing code","","123456",8)}
        ${field("d_port","Debug port",saved.port || "5555","5555",7)}
        <button id="pair-btn" class="ghost"><span class="lbl">Pair &amp; Connect</span></button>
      </div>
    </details>`;
}

function connectedForm() {
  const d = state.device || {};
  return `<h2>Connected</h2>
    <p class="hint">${esc(d.model || "Device")}${d.android ? " · Android " + esc(d.android) : ""} · ${esc(state.target)}</p>
    <div class="row"><button class="warn" id="disconnect-btn"><span class="lbl">Disconnect</span></button></div>`;
}

function renderConnection() {
  const card = $("#connection");
  card.innerHTML = connected ? connectedForm() : connectForm();
  if (connected) {
    $("#disconnect-btn").onclick = doDisconnect;
    return;
  }
  $("#connect-btn").onclick = () => doConnect($("#ip").value.trim(), $("#port").value.trim(), $("#connect-btn"));
  $("#pair-btn").onclick = () => doPair($("#p_ip").value.trim(), $("#p_port").value.trim(),
    $("#p_code").value.trim(), $("#d_port").value.trim(), $("#pair-btn"));
  ["ip","port"].forEach((id) => $("#" + id).addEventListener("keydown", (event) => {
    if (event.key === "Enter") $("#connect-btn").click();
  }));
  const forget = $("#forget-btn");
  if (forget) forget.onclick = forgetTV;
  if (forcePair) { forcePair = false; $("#p_code").focus(); }
}

/* ---------- discovery ---------- */

function deviceRows(devices) {
  const attached = (devices.attached || []).map((d) => `<div class="dev"><span><b>Attached</b></span>
      <span class="addr">${esc(d.address)}</span>
      <span class="tag">${esc(d.status)}</span></div>`);
  const services = (devices.services || []).map((s) => `<div class="dev"><span><b>${esc(s.name)}</b></span>
      <span class="addr">${esc(s.address)}</span>
      <span class="tag ${s.pairable ? "pair" : ""}">${s.pairable ? "needs pairing" : "connectable"}</span>
      <button class="ghost mini" data-dev="${esc(s.address)}" data-pair="${s.pairable ? 1 : 0}">
        <span class="lbl">${s.pairable ? "Use for pairing" : "Connect"}</span></button></div>`);
  return attached.concat(services);
}

async function scan(button) {
  if (connected) return;
  const devices = await (await req("/api/discover", null, button))
    .json().catch(() => ({ services:[], attached:[] }));
  const rows = deviceRows(devices);
  $("#devices").innerHTML = rows.length ? rows.join("")
    : '<p class="hint">Nothing found yet. Enable Wireless debugging on the TV — it advertises itself once on.</p>';
}

/* ---------- package list ---------- */

function appRow(a) {
  return `<div class="app ${a.state === "disabled" ? "off" : ""}" data-row="${esc(a.package)}">
    <input type="checkbox" data-pkg="${esc(a.package)}" ${a.state === "disabled" ? "data-off=1" : ""}>
    <div class="body">
      <div class="nm">${esc(a.label)}
        <span class="chip v-${a.verdict}">${a.verdict}</span>
        <span class="chip r-${a.risk}">${a.risk}</span>
        ${a.state === "disabled" ? '<span class="chip st-disabled">disabled</span>' : ""}
      </div>
      <div class="pk">${esc(a.package)} · ${esc(a.partition)}${a.running ? " · running" : ""}</div>
      <div class="why">${esc(a.note || a.reasons.join(" · "))}</div>
    </div>
    <button class="ghost mini" data-details="${esc(a.package)}"><span class="lbl">Info</span></button>
  </div>`;
}

function matchesFilter(a) {
  if (filter === "disabled") return a.state === "disabled";
  if (filter === "all") return true;
  return a.verdict === filter;
}

function renderApps() {
  const query = $("#q").value.trim().toLowerCase();
  const rows = apps.filter((a) => matchesFilter(a)
    && (!query || (a.label + a.package + a.apk).toLowerCase().includes(query)));
  $("#applist").innerHTML = rows.length ? rows.map(appRow).join("")
    : '<p class="hint">Nothing matches this filter.</p>';

  const bloat = apps.filter((a) => a.verdict === "bloat" && a.state === "enabled").length;
  const off = apps.filter((a) => a.state === "disabled").length;
  $("#apps-hint").textContent =
    `${apps.length} packages read from the device · ${bloat} documented bloat still enabled · `
    + `${off} disabled (use the Disabled filter to re-enable them)`;
  $("#enable-all-btn").style.display = off ? "" : "none";
  $("#enable-all-btn").querySelector(".lbl").textContent = `Re-enable all ${off} disabled`;
}

const selected = (off) => [...document.querySelectorAll("#applist input[type=checkbox]")]
  .filter((box) => box.checked && Boolean(box.dataset.off) === off)
  .map((box) => box.dataset.pkg);

const disabledPackages = () => apps.filter((a) => a.state === "disabled").map((a) => a.package);

async function loadInventory() {
  $("#applist").innerHTML = skeletons(8);
  const data = await (await req("/api/inventory", null, $("#reload-inv")))
    .json().catch(() => ({ ok:false }));
  if (!data.ok) { fail(data.message || "Could not read the package list."); return; }
  apps = data.apps;
  renderApps();
  log(`Read ${data.counts.total} packages from ${data.device.model || state.target} — `
    + `${data.counts.bloat} documented bloat still on, ${data.counts.disabled} disabled.`, "muted");
}

/* ---------- device panel ---------- */

function deviceCells(d, t) {
  const s = t.storage || {};
  const cells = [
    ["Model", d.model], ["Android", d.android + " (SDK " + t.sdk + ")"],
    ["Build", t.build], ["Serial", t.serial], ["Chip", t.abi], ["User", "Owner (0)"],
    ["IP", t.ip], ["Uptime", fmt(t.uptime_hours, " h")], ["Load", t.load],
    ["Memory", fmt(t.memory_free_mb, " MB free of " + fmt(t.memory_mb, " MB"))],
    ["Screen", t.resolution + (t.resolution !== t.physical_resolution ? " (panel " + t.physical_resolution + ")" : "")],
    ["Density", t.density], ["Launcher", t.launcher],
  ];
  return cells.map(([k, v]) => `<div><span>${esc(k)}</span><b>${esc(v || "—")}</b></div>`).join("")
    + `<div style="min-width:200px"><span>Storage · ${esc(s.percent || "—")} used</span>
        <b>${fmt(s.used_mb, " MB")} of ${fmt(s.total_mb, " MB")} (${fmt(s.free_mb, " MB")} free)</b>
        <div class="meter"><i style="width:${esc(s.percent || "0")}"></i></div></div>`;
}

async function loadDevice() {
  const card = $("#device-card");
  card.classList.add("busy");
  const data = await (await req("/api/device", null)).json().catch(() => ({ ok:false }));
  card.classList.remove("busy");
  if (!data.ok) { fail(data.message); return; }
  $("#kv").innerHTML = deviceCells(data.device, data.telemetry);
}

/* One screencap fills every embed on the page — the Device panel and the Remote panel
   each carry one, so a single fetch updates both. */
async function takeScreenshot(button) {
  const wraps = [...document.querySelectorAll(".shot-wrap")];
  const shots = [...document.querySelectorAll(".shot")];
  wraps.forEach((wrap) => wrap.classList.add("loading"));
  if (button) button.dataset.busy = "1";
  busy(true);
  try {
    const response = await fetch("/api/screenshot");
    if (!response.ok) {
      const data = await response.json().catch(() => ({ message:"Screenshot failed." }));
      fail(data.message);
      return;
    }
    const url = URL.createObjectURL(await response.blob());
    shots.forEach((img) => { img.src = url; img.style.display = "block"; });
    log("✓ Screenshot captured.", "ok");
  } catch (error) {
    fail("Screenshot failed: " + error.message);
  } finally {
    busy(false);
    if (button) delete button.dataset.busy;
    wraps.forEach((wrap) => wrap.classList.remove("loading"));
  }
}

/* The remote drives the picture. A press schedules a grab after the TV has had a moment to
   draw the new frame; a press arriving mid-grab is queued rather than stacked, so a held
   D-pad costs one screenshot, not one per repeat. */
let shotBusy = false;
let shotQueued = false;

const wait = (ms) => new Promise((done) => setTimeout(done, ms));

async function followShot(delay) {
  if (shotBusy) { shotQueued = true; return; }
  shotBusy = true;
  try {
    await wait(delay);
    await takeScreenshot();
  } finally {
    shotBusy = false;
    if (shotQueued) { shotQueued = false; followShot(0); }
  }
}

async function fetchLog() {
  const box = $("#logcat");
  box.style.display = "block";
  box.textContent = "Reading logcat …";
  const lines = $("#log-lines").value.trim() || "200";
  const data = await (await req("/api/log?lines=" + encodeURIComponent(lines), null, $("#log-btn")))
    .json().catch(() => ({ ok:false, lines:[] }));
  if (!data.ok) { box.textContent = data.message || "Failed."; return; }
  box.textContent = data.lines.join("\n") || "No output.";
  box.scrollTop = box.scrollHeight;
  log(`Fetched ${data.lines.length} log lines.`, "muted");
}

/* ---------- tunables, launchers ---------- */

async function loadTunables() {
  const card = $("#tune-card");
  card.classList.add("busy");
  const data = await (await req("/api/tunables", null)).json().catch(() => ({ ok:false }));
  card.classList.remove("busy");
  if (!data.ok) { fail(data.message); return; }
  $("#tunables").innerHTML = Object.entries(data.values).map(([name, spec]) => `
    <div class="dev" style="justify-content:space-between">
      <span style="max-width:150px">${esc(name.replace(/_/g, " "))}<br>
        <small style="color:var(--muted)">factory ${esc(spec.factory)}</small></span>
      <input type="text" data-tune="${esc(name)}" value="${esc(spec.value)}" size="5">
      <button class="mini" data-set="${esc(name)}"><span class="lbl">Set</span></button>
      <button class="ghost mini" data-reset="${esc(name)}" data-to="${esc(spec.factory)}">
        <span class="lbl">Reset</span></button>
    </div>`).join("");
}

async function loadLaunchers() {
  const select = $("#launcher-select");
  select.innerHTML = '<option>Loading…</option>';
  const data = await (await req("/api/launcher", null, $("#launcher-load"))).json().catch(() => ({ ok:false }));
  if (!data.ok) { select.innerHTML = ""; fail(data.message); return; }
  select.innerHTML = data.options.map((o) =>
    `<option value="${esc(o.component)}" ${o.package === data.current ? "selected" : ""}>${esc(o.component)}${
      o.package === data.current ? "  (current)" : ""}</option>`).join("")
    || '<option value="">No HOME activity found</option>';
  log(`Launcher role: ${data.current || "unset"} · ${data.options.length} candidates on the device.`, "muted");
}

/* ---------- per-app drawer ---------- */

function drawerFacts(i, data) {
  const mb = (kb) => (kb ? Math.round(kb / 1024) + " MB" : "—");
  return `
    <dl>
      <div><dt>Version</dt><dd>${esc(i.versionName || "—")} (${esc(i.versionCode || "—")})</dd></div>
      <div><dt>SDK</dt><dd>min ${esc(i.minSdk || "—")} / target ${esc(i.targetSdk || "—")}</dd></div>
      <div><dt>Installed by</dt><dd>${esc(i.installerPackageName || "sideload / unknown")}</dd></div>
      <div><dt>APK</dt><dd>${mb(data.apk_kb)}</dd></div>
      <div><dt>Data</dt><dd>${data.data_kb ? mb(data.data_kb) : "not readable"}</dd></div>
      <div><dt>Updated</dt><dd>${esc(i.lastUpdateTime || "—")}</dd></div>
      <div><dt>Permissions</dt><dd>${data.permissions.length}</dd></div>
    </dl>`;
}

const APP_ACTIONS = ["launch", "force-stop", "clear-data", "uninstall-updates",
  "uninstall", "uninstall-user", "reinstall-keep-data"];
const APP_ACTION_LABELS = { launch:"Launch", "force-stop":"Force stop", "clear-data":"Clear data",
  "uninstall-updates":"Uninstall updates", uninstall:"Uninstall",
  "uninstall-user":"Uninstall for user 0", "reinstall-keep-data":"Re-enable for user 0" };
const ACTION_WARNING = {
  "clear-data":"This wipes the app's data and cannot be undone from this tool.",
  "uninstall-updates":"The app drops back to its factory version.",
  uninstall:"Removes the app outright. System apps refuse this and the tool will say so.",
  "uninstall-user":"Removes it for user 0 only — Re-enable for user 0 puts it back.",
};
const DESTRUCTIVE_ACTIONS = ["clear-data", "uninstall-updates", "uninstall", "uninstall-user"];

async function showDetails(packageName, button) {
  const row = document.querySelector(`[data-row="${CSS.escape(packageName)}"]`);
  if (!row) return;
  const existing = row.parentNode.querySelector(`[data-drawer="${CSS.escape(packageName)}"]`);
  if (existing) { existing.remove(); return; }
  document.querySelectorAll(".drawer").forEach((d) => d.remove());

  const drawer = document.createElement("div");
  drawer.className = "drawer";
  drawer.dataset.drawer = packageName;
  drawer.innerHTML = '<div class="sk" style="height:56px"></div>';
  row.after(drawer);

  const data = await (await req("/api/app/" + encodeURIComponent(packageName), null, button))
    .json().catch(() => ({ ok:false, message:"Request failed." }));
  if (!data.ok) { drawer.innerHTML = `<span style="color:var(--bad)">${esc(data.message)}</span>`; return; }
  drawer.innerHTML = drawerFacts(data.info || {}, data) + `
    <div class="acts">
      ${APP_ACTIONS.map((action) => `<button class="ghost mini" data-act="${action}"
        data-pkg="${esc(packageName)}"><span class="lbl">${APP_ACTION_LABELS[action]}</span></button>`).join("")}
    </div>
    <details style="margin-top:8px"><summary>Permissions</summary>
      <div style="font-family:ui-monospace,Consolas,monospace;font-size:11.5px;margin-top:6px">${
        data.permissions.map(esc).join("<br>") || "none reported"}</div></details>`;
}

/* ---------- connection and device actions ---------- */

async function doConnect(ip, port, button) {
  if (!ip) { log("Enter an IP address or pick a discovered device.", "bad"); return; }
  log(`Connecting to ${ip}:${port} …`, "muted");
  const data = await api("/api/connect", { ip, port }, button);
  report(data);
  if (data.ok) rememberTV({ ip, port });
  if (data.hint) { log("→ " + data.hint, "note"); forcePair = true; }
  await refresh();
}

async function doPair(ip, pairPort, code, debugPort, button) {
  if (!code) { log("Enter the 6-digit pairing code shown on the TV.", "bad"); return; }
  log(`Pairing with ${ip}:${pairPort} …`, "muted");
  const data = await api("/api/pair", { ip, pair_port:pairPort, code, debug_port:debugPort }, button);
  report(data);
  if (data.ok) rememberTV({ ip, port:debugPort, pairPort });
  await refresh();
}

async function doDisconnect() {
  const data = await api("/api/disconnect", {}, $("#disconnect-btn"));
  log("✓ " + data.message, "ok");
  apps = [];
  $("#applist").innerHTML = "";
  $("#kv").innerHTML = "";
  document.querySelectorAll(".shot").forEach((img) => { img.style.display = "none"; img.removeAttribute("src"); });
  await refresh();
}

function confirmationFor(path, packages) {
  if (path === "/api/debloat") {
    return confirm(`Disable ${packages.length} package(s) for user 0?\n`
      + "Reversible with Re-enable, but apps that depend on them may stop working until then.");
  }
  if (path === "/api/restore" && packages.length > 1) {
    return confirm(`Re-enable ${packages.length} package(s)?`);
  }
  return true;
}

async function apply(path, packages, button) {
  if (!packages.length) { log("Nothing selected.", "bad"); return; }
  if (!confirmationFor(path, packages)) return;
  const body = { packages };
  if (path === "/api/debloat" && $("#force-core").checked) body.confirm_core = true;

  const data = await api(path, body, button);
  (data.results || []).forEach((r) => {
    const name = r.label && r.label !== r.package ? r.label : r.package;
    report(r, name + " — ", r.detail);
  });
  log(data.message, data.ok ? "ok" : "bad");
  await loadInventory();
}

async function sendKey(key, button) {
  const data = await api("/api/key", { key }, button);
  report(data);
  if (data.ok) followShot(450);
}

async function setTunable(name, value, button) {
  const data = await api("/api/tunables", { name, value }, button);
  report(data);
  if (data.ok) loadTunables();
}

async function runAppAction(packageName, action, button) {
  const destructive = DESTRUCTIVE_ACTIONS.includes(action);
  if (destructive && !confirm(`${action} on ${packageName}?\n${ACTION_WARNING[action] || ""}`)) return;
  const data = await api("/api/app/action", { package:packageName, action, confirm:destructive }, button);
  report(data, action + " · ");
}

async function useDiscoveredDevice(address, needsPairing, button) {
  if (!needsPairing) {
    const [ip, port] = address.split(":");
    doConnect(ip, port, button);
    return;
  }
  forcePair = true;
  renderConnection();
  $("#p_ip").value = address.split(":")[0];
  $("#p_code").focus();
  log(`Endpoint ${address} needs a pairing code — enter the code shown on the TV.`, "note");
}

/* ---------- state refresh ---------- */

async function refresh() {
  state = await (await req("/api/state")).json().catch(() => ({ connected:false }));
  connected = state.connected;
  const pill = $("#status");
  pill.textContent = connected ? "Connected — " + state.target : "Not connected";
  pill.classList.toggle("on", connected);
  $("#adb").textContent = "adb: " + state.adb;
  const d = state.device || {};
  $("#device").textContent = connected && d.model ? `${d.model}${d.android ? " · Android " + d.android : ""}` : "";
  $("#discover-card").style.display = connected ? "none" : "";
  ["device-card","apps-card","apk-card","launcher-card","remote-card","tune-card"]
    .forEach((id) => $("#" + id).classList.toggle("locked", !connected));
  renderConnection();
  if (!connected) return;
  loadDevice();
  loadTunables();
  loadLaunchers();
  if (!apps.length) await loadInventory();
}

/* ---------- control wiring ---------- */
/* Panel buttons by id; anything rendered from device data (filters, keys, app rows,
   tunables, discovered devices) is delegated from document so re-rendered markup needs
   no re-binding. */

const PANEL_BUTTONS = {
  "#rescan": () => scan($("#rescan")),
  "#reload-inv": loadInventory,
  "#dev-refresh": loadDevice,
  "#shot-btn": takeScreenshot,
  "#shot-btn-2": takeScreenshot,
  "#log-btn": fetchLog,
  "#tune-refresh": loadTunables,
  "#launcher-load": loadLaunchers,
  "#disable-btn": (button) => apply("/api/debloat", selected(false), button),
  "#enable-btn": (button) => apply("/api/restore", selected(true), button),
  "#enable-all-btn": (button) => apply("/api/restore", disabledPackages(), button),
};

Object.entries(PANEL_BUTTONS).forEach(([selector, handler]) => {
  $(selector).addEventListener("click", (event) => handler(event.currentTarget));
});

$("#q").addEventListener("input", renderApps);

$("#reboot-btn").addEventListener("click", async (event) => {
  if (!confirm("Reboot the TV now?\nADB drops for about a minute and Wireless debugging may need re-enabling.")) return;
  const data = await api("/api/reboot", { confirm:true }, event.currentTarget);
  report(data);
  if (data.ok) setTimeout(refresh, 45000);
});

$("#launcher-set").addEventListener("click", async (event) => {
  const component = $("#launcher-select").value;
  if (!component) { log("No HOME activity to pick — Refresh re-reads them from the TV.", "bad"); return; }
  if (!confirm(`Set the default home activity to ${component}?`)) return;
  const data = await api("/api/launcher/set", { component }, event.currentTarget);
  report(data);
  if (data.ok) loadLaunchers();
});

$("#launcher-btn").addEventListener("click", async (event) => {
  if (!confirm("Disable the Google TV Launcher? Only after a replacement launcher is confirmed working.")) return;
  report(await api("/api/launcher/disable", {}, event.currentTarget), "Launcher: ");
});

/* A recommendation is only ever its project link, never a pinned file: clicking Install resolves
   the newest published release at that moment and takes the asset matching the connected box's
   instruction set. The layout tag is what each project's APK manifest declared when it was read on
   2026-10-08 — a Leanback launcher is what puts a tile on the TV home screen; without one the app
   still installs and runs, just in its phone layout. */
const RECOMMENDED = [
  { name:"SmartTube", repo:"https://github.com/yuliskov/SmartTube", tv:true,
    why:"Ad-free YouTube in its own interface built for a remote, no Google sign-in. One APK per instruction set." },
  { name:"Home Assistant", repo:"https://github.com/home-assistant/android", tv:true,
    why:"Self-hosted smart-home dashboards — the TV as a wall panel. The wear and automotive builds are skipped." },
  { name:"Jellyfin", repo:"https://github.com/jellyfin/jellyfin-androidtv", tv:true,
    why:"Self-hosted media client, TV front-end (org.jellyfin.androidtv): your library, no subscription." },
  { name:"ReVanced Manager", repo:"https://github.com/ReVanced/revanced-manager", tv:false,
    why:"Builds patched APKs on the device. Android TV support is still dev-only past v2.6.0, so expect a phone layout." },
];

function renderRecs() {
  $("#recs").innerHTML = RECOMMENDED.map((r) => `
    <div class="rec">
      <div class="body">
        <div class="nm">${esc(r.name)}
          <span class="tag${r.tv ? "" : " pair"}">${r.tv ? "TV layout" : "Phone layout"}</span></div>
        <div class="why">${esc(r.why)}</div>
        <a class="src" href="${esc(r.repo)}" target="_blank" rel="noopener">${
          esc(r.repo.replace("https://github.com/", ""))}</a>
      </div>
      <button class="ghost mini" data-rec="${esc(r.repo)}"><span class="lbl">Install</span></button>
    </div>`).join("");
}

renderRecs();

/* One installer serves both panels (Install APK and the Launcher card): a picked file wins
   over a pasted URL, and on success the package list is re-read — the Launcher card also
   refreshes its picker so a freshly installed home app shows up straight away. */
async function installApk(fileInput, urlInput, button, afterwards) {
  const url = urlInput.value.trim();
  let data;
  if (fileInput.files.length) {
    const form = new FormData();
    form.append("file", fileInput.files[0]);
    log("Installing " + fileInput.files[0].name + " …", "muted");
    data = await api("/api/install", form, button);
  } else if (url) {
    log("Fetching " + url + " …", "muted");
    data = await api("/api/install", { url }, button);
  } else {
    log("Pick an APK or paste a URL first.", "bad");
    return;
  }
  report(data);
  if (!data.ok) return;
  fileInput.value = "";
  urlInput.value = "";
  await loadInventory();
  if (afterwards) await afterwards();
}

$("#install-btn").addEventListener("click", (event) =>
  installApk($("#apk"), $("#apk-url"), event.currentTarget));
$("#launcher-install").addEventListener("click", (event) =>
  installApk($("#launcher-apk"), $("#launcher-apk-url"), event.currentTarget, loadLaunchers));

document.addEventListener("click", async (event) => {
  const chip = event.target.closest("[data-filter]");
  if (chip) {
    filter = chip.dataset.filter;
    document.querySelectorAll("[data-filter]").forEach((b) => b.classList.toggle("on", b === chip));
    renderApps();
    return;
  }
  const key = event.target.closest("[data-key]");
  if (key) { sendKey(key.dataset.key, key); return; }

  const rec = event.target.closest("[data-rec]");
  if (rec) {
    // Goes through the URL field so the log names the same link the row shows.
    $("#apk-url").value = rec.dataset.rec;
    await installApk($("#apk"), $("#apk-url"), rec);
    return;
  }

  const details = event.target.closest("[data-details]");
  if (details) { showDetails(details.dataset.details, details); return; }

  const act = event.target.closest("[data-act]");
  if (act) { runAppAction(act.dataset.pkg, act.dataset.act, act); return; }

  const tune = event.target.closest("[data-set], [data-reset]");
  if (tune) {
    const name = tune.dataset.set || tune.dataset.reset;
    const box = document.querySelector(`[data-tune="${CSS.escape(name)}"]`);
    setTunable(name, tune.dataset.reset ? tune.dataset.to : box.value.trim(), tune);
    return;
  }

  const dev = event.target.closest("[data-dev]");
  if (dev) useDiscoveredDevice(dev.dataset.dev, dev.dataset.pair === "1", dev);
});

/* One automatic reconnect per page load, from the address this browser saved. Wireless
   debugging survives a container or PC restart, so usually nothing needs clicking. Pairing
   can't be automated — the 6-digit code changes each time — so a TV that rebooted still
   needs Pair & Connect; the failed attempt prints the hint that points there. */
async function autoConnect() {
  const saved = savedTV();
  if (!saved.ip) return;
  await doConnect(saved.ip, saved.port || "5555");
}

(async function start() {
  await refresh();
  if (!connected) await autoConnect();
  await scan();
  setInterval(scan, 6000);
})();
