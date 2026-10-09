import * as lib from "https://cdn.jsdelivr.net/npm/@yume-chan/adb@3.0.0-beta.3/+esm";
import * as stream from "https://cdn.jsdelivr.net/npm/@yume-chan/stream-extra@3.0.0-beta.3/+esm";
import { AdbWebCryptoCredentialManager, TangoLocalStorage } from "https://cdn.jsdelivr.net/npm/@yume-chan/adb-credential-web@3.0.0-beta.3/+esm";
import { openAdb, shellFor } from "./adb-client.js";
import { detectPackages, deviceInfo } from "./inventory.js";
import { importKey } from "./keys.js";

const KEY_STORE = "adb-keys";
const KEY_NAME = "this browser";
const VERDICTS = ["bloat", "careful", "undocumented", "keep"];
const FACTS = [
    ["model", "Model"], ["release", "Android"], ["sdk", "SDK"], ["abi", "ABI"],
    ["hardware", "Hardware"], ["board", "Board"], ["product", "Product"], ["build", "Build"],
];

const $ = (id) => document.getElementById(id);
const store = new TangoLocalStorage(KEY_STORE);
const credentials = new AdbWebCryptoCredentialManager(store, KEY_NAME);

let adb = null;
let sh = null;
let rows = [];
const active = new Set();

function say(message, kind = "", spinning = false) {
    $("status-text").textContent = message;
    $("status").className = kind;
    $("spinner").hidden = !spinning;
}

// Text keyed to the device's own auth events, so the TV-approval prompt appears when the device asks
// for approval rather than after a guessed delay.
const AUTH_TEXT = {
    signing: (event) => `Signing with this browser's key${event.name ? ` (${event.name})` : ""}…`,
    rejected: () => "The TV did not accept that key — trying another.",
    "waiting-for-tv": () => "You might have to authorize on the TV: accept “Allow USB debugging” on the screen.",
    "key-error": (event) => `A stored key could not be read: ${event.message}`,
};
const AUTH_KIND = { "waiting-for-tv": "warn", rejected: "warn", "key-error": "warn" };

function keyState() {
    $("key-state").textContent = localStorage.getItem(KEY_STORE)
        ? "A key is stored in this browser — the tab will sign with it."
        : "No key in this browser yet: connect once and tap Allow on the TV, or import the key it already trusts below.";
}

function chip(text, klass) {
    const span = document.createElement("span");
    span.className = `badge ${klass}`;
    span.textContent = text;
    return span;
}

function renderFacts(info) {
    const list = $("device-facts");
    list.textContent = "";
    for (const [key, label] of FACTS) {
        const dt = document.createElement("dt");
        dt.textContent = label;
        const dd = document.createElement("dd");
        dd.textContent = info[key] || "—";
        list.append(dt, dd);
    }
    $("device-card").hidden = false;
}

function buildFilters() {
    const host = $("verdict-filters");
    host.textContent = "";
    for (const verdict of VERDICTS) {
        const chipButton = document.createElement("button");
        chipButton.className = "chip";
        chipButton.type = "button";
        chipButton.textContent = verdict;
        chipButton.setAttribute("aria-pressed", "false");
        chipButton.onclick = () => {
            active.has(verdict) ? active.delete(verdict) : active.add(verdict);
            chipButton.setAttribute("aria-pressed", String(active.has(verdict)));
            renderRows();
        };
        host.append(chipButton);
    }
}

function visible(row) {
    if (active.size && !active.has(row.verdict)) {
        return false;
    }
    if ($("hide-core").checked && row.risk === "core") {
        return false;
    }
    if ($("only-disabled").checked && row.state !== "disabled") {
        return false;
    }
    const needle = $("search").value.trim().toLowerCase();
    if (!needle) {
        return true;
    }
    return [row.package, row.label, row.reasons.join(" "), row.note, row.partition, row.installer]
        .join(" ").toLowerCase().includes(needle);
}

function renderRows() {
    const body = $("inventory").tBodies[0];
    body.textContent = "";
    const shown = rows.filter(visible);
    for (const row of shown) {
        const tr = document.createElement("tr");
        if (row.state === "disabled") {
            tr.className = "disabled";
        }

        const pkg = document.createElement("td");
        pkg.className = "pkg";
        const name = document.createElement("strong");
        name.textContent = row.label;
        const sub = document.createElement("span");
        sub.className = "sub";
        sub.textContent = row.package;
        const badges = document.createElement("div");
        badges.className = "chips";
        badges.append(chip(row.risk, row.risk), chip(row.verdict, row.verdict));
        if (row.state === "disabled") {
            badges.append(chip("disabled", "off"));
        }
        if (row.running) {
            badges.append(chip("running", "visible"));
        }
        pkg.append(name, sub, badges);

        const why = document.createElement("td");
        const reasons = document.createElement("div");
        reasons.className = "why";
        reasons.textContent = row.reasons.join(" · ");
        why.append(reasons);
        if (row.note) {
            const note = document.createElement("div");
            note.className = "note";
            note.textContent = row.note;
            why.append(note);
        }

        const where = document.createElement("td");
        where.className = "where";
        where.textContent = `${row.partition} · uid ${row.uid}${row.installer ? `\nvia ${row.installer}` : ""}`;

        tr.append(pkg, why, where);
        body.append(tr);
    }
    const tally = VERDICTS.map((verdict) => `${rows.filter((row) => row.verdict === verdict).length} ${verdict}`);
    $("counts").textContent = `— ${shown.length} of ${rows.length} shown · ${tally.join(" · ")}`;
}

async function scan() {
    const started = performance.now();
    $("rescan").disabled = true;
    say("Reading the device…", "", true);
    try {
        rows = await detectPackages(sh);
    } finally {
        $("rescan").disabled = false;
    }
    if (!rows.length) {
        // A wrong service string or a shell that refuses the command reads as an empty inventory,
        // which would otherwise look like a clean, empty TV.
        say("The device answered but nothing parsed as a package list — refusing to show an empty TV.", "error");
        $("inventory-card").hidden = true;
        return;
    }
    renderRows();
    $("inventory-card").hidden = false;
    say(`Read ${rows.length} packages in ${((performance.now() - started) / 1000).toFixed(1)}s`, "ok");
}

async function connect() {
    const relay = $("relay").value.trim();
    const target = $("target").value.trim();
    const token = $("token").value.trim();
    if (!target) {
        say("Enter the TV's address, e.g. 192.168.5.107", "error");
        return;
    }
    localStorage.setItem("relay", relay);
    localStorage.setItem("target", target);
    localStorage.setItem("token", token);
    $("connect").disabled = true;
    say("Connecting…", "", true);
    try {
        const openedAdb = await openAdb({
            lib,
            stream,
            url: `ws://${relay}/adb/${target}?token=${encodeURIComponent(token)}`,
            credentialManager: credentials,
            onEvent: (event) => say(AUTH_TEXT[event.type]?.(event) || event.type, AUTH_KIND[event.type] || "", true),
        });
        adb = openedAdb.adb;
        sh = shellFor(adb);
        // A tab with no key generates one during the handshake, so re-read the panel after connecting.
        keyState();
        renderFacts(await deviceInfo(sh));
        // This page only exists to get you connected; the toolkit itself is the app. Remember the TV in
        // the key the toolkit's own page reads, then hand over with the address so it reconnects itself.
        const [ip, port] = (target.includes(":") ? target : `${target}:5555`).split(":");
        localStorage.setItem("toolkit.tv", JSON.stringify({ ip, port }));
        say(`Connected to ${target} — opening the toolkit…`, "ok", true);
        setTimeout(() => { location.href = `/toolkit?connect=${encodeURIComponent(`${ip}:${port}`)}`; }, 700);
    } catch (error) {
        adb = null;
        sh = null;
        say(error?.message || String(error), "error");
    } finally {
        $("connect").disabled = false;
    }
}

$("connect").onclick = connect;
$("rescan").onclick = () => sh && scan().catch((error) => say(error.message, "error"));
$("search").oninput = renderRows;
$("hide-core").onchange = renderRows;
$("only-disabled").onchange = renderRows;

$("import-key").onclick = () => {
    try {
        importKey({ lib, store, name: KEY_NAME, text: $("key-paste").value });
        $("key-paste").value = "";
        keyState();
        say("Key stored in this browser.", "ok");
    } catch (error) {
        say(error.message, "error");
    }
};

$("generate-key").onclick = async () => {
    try {
        await credentials.generateKey();
        keyState();
        say("New key stored. The TV will ask you to allow it once.", "ok");
    } catch (error) {
        say(error?.message
            || "This browser will not generate a key here — WebCrypto needs http://127.0.0.1 (loopback counts) or https.", "error");
    }
};

// A page the relay serves is same-origin with it, so the relay hands over its own address and token:
// typing the TV's IP is then the whole job, exactly as it was when a server did the adb. Hosted
// anywhere else, the relay is a different machine and both fields stay open.
const injected = document.querySelector('meta[name="relay-token"]');
if (injected && injected.content && !injected.content.includes("__RELAY")) {
    $("relay").value = location.host;
    $("token").value = injected.content;
} else {
    $("advanced").hidden = false;
    if (localStorage.getItem("relay")) {
        $("relay").value = localStorage.getItem("relay");
    }
    if (localStorage.getItem("token")) {
        $("token").value = localStorage.getItem("token");
    }
}
if (localStorage.getItem("target")) {
    $("target").value = localStorage.getItem("target");
}
buildFilters();
keyState();
