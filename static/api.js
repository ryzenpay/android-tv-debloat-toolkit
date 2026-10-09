/* Transport, activity log and busy indication. Everything the page draws lives in app.js. */

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

/* One place owns the loading indication: the bar moves while anything is in flight,
   and the button or card that started the call spins until it settles. */
function busy(on) {
  inFlight = Math.max(0, inFlight + (on ? 1 : -1));
  $("#bar").classList.toggle("on", inFlight > 0);
}

function report(data, prefix, message) {
  log((data.ok ? "✓ " : "✗ ") + (prefix || "") + (message === undefined ? data.message : message),
    data.ok ? "ok" : "bad");
}

const fail = (message) => log("✗ " + message, "bad");

// Every caller either sends nothing (GET), a JSON body, or an uploaded APK.
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
