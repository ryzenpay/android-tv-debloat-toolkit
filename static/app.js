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

/* One row per TV — the engine folds the box's several advertisements (plain port, wireless-debugging
   port, pairing port) and adb's own attached list into a single device, so nothing here dedupes. */
function deviceRows(payload) {
  return (payload.devices || []).map((d) => {
    const tag = d.status ? (d.status === "device" ? "attached" : d.status)
      : d.pairable ? "needs pairing" : "connectable";
    const also = (d.other || []).map((o) => `also ${o.address}${o.pairable ? " (pair first)" : ""}`)
      .join(" · ");
    return `<div class="dev" data-dev="${esc(d.address)}" data-pair="${d.pairable ? 1 : 0}"
        data-pair-port="${esc(d.pair_port)}" title="Fill the address fields with this">
      <span><b>${esc(d.name)}</b></span>
      <span class="addr">${esc(d.address)}</span>
      <span class="tag ${d.pairable && !d.status ? "pair" : ""}">${esc(tag)}</span>
      ${also ? `<span class="addr">${esc(also)}</span>` : ""}
    </div>`;
  }).join("");
}

async function scan(button) {
  if (connected) return;
  const devices = await (await req("/api/discover", null, button))
    .json().catch(() => ({ devices: [] }));
  $("#devices").innerHTML = deviceRows(devices)
    || '<p class="hint">Nothing found yet. Enable Wireless debugging on the TV — it advertises itself once on.</p>';
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
  /* Each segment counts itself through matchesFilter, so a number above the list can never disagree
     with what clicking that segment shows. */
  document.querySelectorAll(".seg [data-filter]").forEach((chip) => {
    chip.querySelector(".n").textContent = apps.length ? apps.filter((a) => matchesFilter(a)).length : "";
  });
  syncSelectAll();
}

/* The master box speaks for the rows on screen, never for the whole inventory — the filter and the
   search both re-render the list, so it re-reads itself from whatever survived the re-render and goes
   indeterminate when only part of what is visible is ticked. */
function visibleBoxes() {
  return [...document.querySelectorAll("#applist input[type=checkbox]")];
}

function syncSelectAll() {
  const boxes = visibleBoxes();
  const on = boxes.filter((box) => box.checked).length;
  const master = $("#sel-all");
  master.checked = boxes.length > 0 && on === boxes.length;
  master.indeterminate = on > 0 && on < boxes.length;
  master.disabled = !boxes.length;
  $("#sel-count").textContent = !boxes.length ? "nothing shown"
    : on === boxes.length ? `all ${boxes.length} shown selected`
    : `${on} of ${boxes.length} shown selected`;
}

function setAllVisible(on) {
  visibleBoxes().forEach((box) => { box.checked = on; });
  syncSelectAll();
}

const selected = (off) => [...document.querySelectorAll("#applist input[type=checkbox]")]
  .filter((box) => box.checked && Boolean(box.dataset.off) === off)
  .map((box) => box.dataset.pkg);

const disabledPackages = () => apps.filter((a) => a.state === "disabled").map((a) => a.package);

async function loadInventory() {
  $("#applist").innerHTML = skeletons(8);
  const response = await req("/api/inventory", null, $("#reload-inv"));
  const [data] = await Promise.all([
    response.json().catch(() => ({ ok:false })),
    loadUserApps(),               // the Install APK panel is rendered from the same read
  ]);
  if (!data.ok) { fail(data.message || "Could not read the package list."); return; }
  apps = data.apps;
  renderApps();
  renderInstalled();
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

/* One screencap feeds both embeds — the small one in the Remote control card and the full-size one the
   viewer opens — and the blob it came from is released as soon as the next one is in place. */
let shotUrl = null;

async function takeScreenshot(button) {
  const shots = [...document.querySelectorAll(".shot")];
  const boxes = [...document.querySelectorAll(".shot-wrap, .viewer-box")];
  boxes.forEach((box) => box.classList.add("loading"));
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
    shots.forEach((img) => { img.src = url; });
    document.querySelectorAll(".shot-wrap").forEach((wrap) => wrap.classList.add("filled"));
    if (shotUrl) URL.revokeObjectURL(shotUrl);
    shotUrl = url;
    log("✓ Screenshot captured.", "ok");
  } catch (error) {
    fail("Screenshot failed: " + error.message);
  } finally {
    busy(false);
    if (button) delete button.dataset.busy;
    boxes.forEach((box) => box.classList.remove("loading"));
  }
}

/* Opening the picture is also how the first capture happens: the Screenshot button is gone, and nothing
   asks the TV for a frame until a frame is actually wanted. The remote is cloned in beside the picture
   so the screen can be driven from here; its buttons are handled by document-level delegation, so the
   copy works untouched — including the refresh icon it carries. */
function openViewer() {
  const copy = $("#remote").cloneNode(true);
  copy.removeAttribute("id");
  $("#viewer-remote").replaceChildren(copy);
  $("#viewer").hidden = false;
  document.body.classList.add("viewer-open");
  if (!shotUrl) takeScreenshot();
}

function closeViewer() {
  $("#viewer").hidden = true;
  document.body.classList.remove("viewer-open");
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
    <div class="tunerow">
      <span class="nm">${esc(name.replace(/_/g, " "))}<br><small>factory ${esc(spec.factory)}</small></span>
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
  /* The drawer opens next to the control that was pressed. The same app also has a row in the Apps
     list, and that one can be filtered out or scrolled off screen — looking only for it made Details
     on an installed app do nothing at all. */
  const row = (button && button.closest("[data-row]"))
    || document.querySelector(`[data-row="${CSS.escape(packageName)}"]`);
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
  closeViewer();
  document.querySelectorAll(".shot").forEach((img) => img.removeAttribute("src"));
  document.querySelectorAll(".shot-wrap").forEach((wrap) => wrap.classList.remove("filled"));
  if (shotUrl) { URL.revokeObjectURL(shotUrl); shotUrl = null; }
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

/* A click fills the address fields and stops there — it used to connect immediately, which made an
   accidental click start a transport. Only a _adb-tls-pairing._tcp advertisement may fill the pairing
   port: wireless debugging's own port is a connect port, and putting it there just fails later. */
function useDiscoveredDevice(address, needsPairing, pairPort) {
  if (!$("#ip")) return;
  const [host, port] = address.split(":");
  $("#ip").value = host;
  $("#port").value = port || "5555";
  if (!needsPairing && !pairPort) {
    log(`Filled ${host}:${port || "5555"} — press Connect when you are ready.`, "note");
    return;
  }
  $("#pair-details").open = true;
  $("#p_ip").value = host;
  const pairOnly = pairPort ? pairPort.split(":")[1] : "";
  if (pairOnly) $("#p_port").value = pairOnly;
  $("#p_code").focus();
  log(pairOnly
    ? `${host} also advertises its pairing port (${pairOnly}) — enter the 6-digit code from the TV.`
    : `${address} is wireless debugging's connect port and needs a code first; the pairing port is on the TV's screen.`,
    "note");
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
$("#sel-all").addEventListener("change", (event) => setAllVisible(event.target.checked));
document.addEventListener("change", (event) => {
  if (event.target.matches("#applist input[type=checkbox]")) syncSelectAll();
});

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

/* A recommendation is only ever its project link plus the copy this checkout carries: no pinned
   download URLs. The layout tag was read out of each cached APK's own manifest on 2026-10-08 — a
   Leanback launcher entry is what puts a tile on the TV home screen; without one the app still
   installs and runs, just in its phone layout. "installed" comes from the package list the device
   reports as yours, never from a saved list. */
const RECOMMENDED = [
  { name:"SmartTube", repo:"https://github.com/yuliskov/SmartTube", tv:true,
    why:"Ad-free YouTube in its own interface built for a remote, no Google sign-in. One APK per instruction set." },
  { name:"Home Assistant", repo:"https://github.com/home-assistant/android", tv:true,
    why:"Self-hosted smart-home dashboards — the TV as a wall panel. The wear and automotive builds are skipped." },
  { name:"Jellyfin", repo:"https://github.com/jellyfin/jellyfin-androidtv", tv:true,
    why:"Self-hosted media client, TV front-end (org.jellyfin.androidtv): your library, no subscription." },
  { name:"Nova Video Player", repo:"https://github.com/nova-video-player/aos-AVP", tv:true,
    why:"Plays a NAS share or a local file with its own ffmpeg codecs — the box's decoder is not the limit here." },
  { name:"LocalSend", repo:"https://github.com/localsend/localsend", tv:true,
    why:"Move files between this computer and the box over the LAN: no cloud, no cable, no adb." },
  { name:"ReVanced Manager", repo:"https://github.com/ReVanced/revanced-manager", tv:false,
    why:"Builds patched APKs on the device. Android TV support is still dev-only past v2.6.0, so expect a phone layout." },
];

/* Install on a recommendation uses the APK committed beside this checkout (apks/index.json, written
   by refresh_apks.py for one instruction set). An entry with no cached file shows its project link
   and nothing else — the button exists because the file does, never because markup claims it. */
let cachedApks = new Map();

async function loadApks() {
  const data = await (await req("/api/apks")).json().catch(() => ({ files: [] }));
  cachedApks = new Map(((data && data.files) || []).map((row) => [String(row.repo).toLowerCase(), row]));
  renderRecs();
}

const cachedFor = (repo) => cachedApks.get(repo.replace("https://github.com/", "").toLowerCase());

/* The device decides which packages arrived after the factory image — `pm list packages -3` is its own
   answer, and it is the only one that holds up: uid ranges do not separate the two, because APEX modules
   get uids in the same band as apps you installed (com.android.wifi.resources is uid 10101 on this box). */
let userPackages = null;
let userAppsWhy = "";

async function loadUserApps() {
  const data = await (await req("/api/user-apps")).json()
    .catch(() => ({ ok:false, message:"The toolkit could not read the TV's installed-app list" }));
  userPackages = data.ok ? new Set(data.packages) : null;
  userAppsWhy = data.ok ? "" : (data.message || "The TV did not answer that read");
}

const userApps = () => (userPackages ? apps.filter((a) => userPackages.has(a.package)) : []);

/* Matched on the package id, not on a name: this Android 14 box exposes no label to ADB at all
   (dumpsys has no application-label and the box ships no aapt), so the only device-sourced string that
   identifies an app is its package. A recommendation whose id doesn't contain its name simply goes
   untagged — the test can miss, it cannot invent a match. */
const onDevice = (name) => {
  const first = name.toLowerCase().split(" ")[0];
  const whole = name.toLowerCase().replace(/[^a-z]/g, "");
  return userApps().find((a) => {
    const id = a.package.toLowerCase();
    return id.includes(first) || id.replace(/[^a-z0-9]/g, "").includes(whole);
  });
};

function renderRecs() {
  const box = $("#recs");
  if (!box) return;
  box.innerHTML = RECOMMENDED.map((r) => {
    const here = onDevice(r.name);
    const file = cachedFor(r.repo);
    const label = file ? `${file.asset} · ${(file.bytes / 1048576).toFixed(1)} MB · ${file.abi}` : "";
    return `
    <div class="rec">
      <div class="body">
        <div class="nm">${esc(r.name)}
          <span class="tag${r.tv ? "" : " pair"}">${r.tv ? "TV layout" : "Phone layout"}</span>
          ${here ? `<span class="tag">${esc(r.name)} installed</span>` : ""}</div>
        <div class="why">${esc(r.why)}</div>
        <a class="src" href="${esc(r.repo)}" target="_blank" rel="noopener">${
          esc(r.repo.replace("https://github.com/", ""))}</a>
        <div class="why">${file ? `cached here: ${esc(file.tag)} · ${(file.bytes / 1048576).toFixed(1)} MB · ${
          esc(file.abi)}` : "not cached in this checkout — get the build for this box from the project, then "
          + "choose the file above"}</div>
      </div>
      ${file ? `<button class="mini" data-cache="${esc(file.file)}" title="${esc(label)}">
        <span class="lbl">Install ${esc(file.tag)}</span></button>` : ""}
    </div>`;
  }).join("");
}

function renderInstalled() {
  const box = $("#installed");
  if (!box) return;
  const rows = userApps();
  box.innerHTML = userAppsWhy
    ? `<p class="legend">${esc(userAppsWhy)} — Rescan packages tries again.</p>`
    : !userPackages
    ? '<p class="legend">Reading what the TV counts as installed…</p>'
    : rows.length
    ? rows.map((a) => `
      <div class="rec" data-row="${esc(a.package)}">
        <div class="body">
          <div class="nm">${esc(a.package)}</div>
          <div class="why">Installed by ${esc(a.installer || "sideload / unknown")} · uid ${esc(a.uid)}${
            a.state === "disabled" ? " · disabled" : ""}</div>
        </div>
        <button class="ghost mini" data-details="${esc(a.package)}"><span class="lbl">Details</span></button>
      </div>`).join("")
    : '<p class="legend">Nothing installed by you — every package on the box came with it.</p>';
  renderRecs();
}

/* One installer serves both panels (Install APK and the Launcher card): only a file picked from this
   computer is ever installed. A pasted URL needed the server to download it, which the browser-side
   engine cannot do for hosts like GitHub that send no cross-origin headers. On success the package
   list is re-read — the Launcher card also refreshes its picker. */
async function installApk(fileInput, button, afterwards) {
  if (!fileInput.files.length) { log("Pick an APK first.", "bad"); return; }
  const form = new FormData();
  form.append("file", fileInput.files[0]);
  log("Installing " + fileInput.files[0].name + " …", "muted");
  const data = await api("/api/install", form, button);
  report(data);
  if (!data.ok) return;
  fileInput.value = "";
  await loadInventory();
  if (afterwards) await afterwards();
}

/* A recommendation's button names a file, never a URL: the engine looks that name up in
   apks/index.json and refuses anything the manifest does not list, so it cannot be steered at a
   path or a host. */
async function installCached(file, button) {
  log("Installing " + file + " …", "muted");
  const data = await api("/api/install", { cached: file }, button);
  report(data);
  if (!data.ok) return;
  await loadInventory();
  await loadLaunchers();
}

$("#install-btn").addEventListener("click", (event) =>
  installApk($("#apk"), event.currentTarget));
$("#launcher-install").addEventListener("click", (event) =>
  installApk($("#launcher-apk"), event.currentTarget, loadLaunchers));

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

  const details = event.target.closest("[data-details]");
  if (details) { showDetails(details.dataset.details, details); return; }

  const cached = event.target.closest("[data-cache]");
  if (cached) { installCached(cached.dataset.cache, cached); return; }

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
  if (dev) { useDiscoveredDevice(dev.dataset.dev, dev.dataset.pair === "1", dev.dataset.pairPort); return; }

  if (event.target.closest("[data-shot-open]")) { openViewer(); return; }
  if (event.target.closest("[data-shot-close]")) { closeViewer(); return; }
  const refresh = event.target.closest("[data-shot-refresh]");
  if (refresh) { takeScreenshot(refresh); return; }
  if (event.target.classList.contains("viewer")) closeViewer();   // backdrop click
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !$("#viewer").hidden) closeViewer();
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
  await loadApks();          // what this checkout carries is not device state, so read it first
  await refresh();
  if (!connected) await autoConnect();
  await scan();
  setInterval(scan, 6000);
})();
