// Port of adb_core.detect_packages(). Same device reads, same order, same risk ladder, same sort.
// Risk is inferred from partition, uid, system roles, installer and process liveness — never from a
// package name list. It ranks candidates; it does not guarantee safety.
import { KNOWN_NOTES } from "./notes.js";

const ROLE_QUERIES = [
    ["home", "cmd package query-activities -a android.intent.action.MAIN -c android.intent.category.HOME"],
    ["launcher", "cmd package query-activities -a android.intent.action.MAIN -c android.intent.category.LEANBACK_LAUNCHER"],
    ["launcher", "cmd package query-activities -a android.intent.action.MAIN -c android.intent.category.LAUNCHER"],
    ["input", "cmd package query-services -a android.view.InputMethod"],
    ["accessibility", "cmd package query-services -a android.accessibilityservice.AccessibilityService"],
    ["screensaver", "cmd package query-services -a android.service.dreams.DreamService"],
    ["device-admin", "cmd package query-receivers -a android.app.action.DEVICE_ADMIN_ENABLED"],
];
const CORE_ROLES = ["home", "input", "accessibility", "device-admin"];
const PACKAGE_LINE = /^package:(.+)=(\S+) uid:(\d+)$/;
// Two spaces before installer= on this Android, and installer=null when the box has no installer.
const INSTALLER_LINE = /^package:(\S+)\s+installer=(\S+)$/;
const VERDICT_ORDER = ["bloat", "careful", "undocumented", "keep"];
const RISK_ORDER = ["unknown", "caution", "visible", "user", "overlay", "core"];

const lines = (text) => (text || "").split("\n");
const packageNames = (text) => lines(text).filter((line) => line.startsWith("package:")).map((line) => line.slice("package:".length));

async function rolePackages(sh, query) {
    const out = await sh(`${query} | grep -o 'packageName=[^ ]*' | sort -u`);
    const found = new Set();
    for (const line of lines(out)) {
        if (line.startsWith("packageName=")) {
            found.add(line.slice("packageName=".length));
        }
    }
    return found;
}

// {overlay package: package whose resources it rewrites}, straight from the device. Overlay ids lie
// about their target often enough to matter, so this is read, never inferred from the name.
async function overlayTargets(sh) {
    const targets = Object.create(null);   // keys come from the device; no inherited keys may read as data
    let current = "";
    for (let line of lines(await sh("cmd overlay list"))) {
        line = line.trim();
        if (line.startsWith("[x] ") && current) {
            targets[line.slice(4)] = current;
        } else if (line && !line.startsWith("[")) {
            current = line.replace(/^-+/, "").replace(/:+$/, "").trim();
        }
    }
    return targets;
}

function partitionOf(path) {
    if (path.includes("/apex/") || path.includes("framework-res")) {
        return "apex";
    }
    if (path.startsWith("/data/app/")) {
        return "data";
    }
    return path.replace(/^\/+/, "").split("/")[0];
}

function apkName(path) {
    const base = path.slice(path.lastIndexOf("/") + 1);
    const dot = base.lastIndexOf(".");
    return dot > 0 ? base.slice(0, dot) : base;
}

function classify({ path, package: pkg, uid }, { disabled, third, installers, running, roles, overlays }) {
    const partition = partitionOf(path);
    const reasons = [];
    const pkgRoles = roles.get(pkg) || new Set();
    const coreRoles = [...pkgRoles].filter((role) => CORE_ROLES.includes(role)).sort();
    let risk;
    if (path.includes("/overlay/")) {
        risk = "overlay";
        reasons.push(overlays[pkg] === undefined
            ? "resource overlay — rewrites system resources, not an app"
            : `resource overlay of ${overlays[pkg]} — rewrites that package's resources, not an app`);
    } else if (uid === "1000" || uid === "2000") {
        risk = "core";
        reasons.push(`runs as the ${uid === "1000" ? "system" : "adb shell"} uid`);
    } else if (partition === "apex" || partition === "vendor") {
        risk = "core";
        reasons.push(`${partition} partition`);
    } else if (path.includes("/system/framework/")) {
        risk = "core";
        reasons.push("framework resource");
    } else if (coreRoles.length) {
        risk = "core";
        coreRoles.forEach((role) => reasons.push(`provides ${role}`));
    } else if (partition === "data" && third.has(pkg)) {
        risk = "user";
        reasons.push("installed by you");
    } else if (partition === "data") {
        risk = "caution";
        reasons.push(installers.get(pkg) === "com.android.vending" ? "updated from the Play Store" : "replaced its system copy");
    } else if (["launcher", "home"].some((role) => pkgRoles.has(role))) {
        risk = "visible";
        reasons.push("has a home-screen entry");
    } else if (running.has(pkg)) {
        risk = "caution";
        reasons.push("process is running now");
    } else {
        risk = "unknown";
        reasons.push("no home-screen entry and no running process, and its purpose is not documented here");
    }
    return { partition, risk, reasons, state: disabled.has(pkg) ? "disabled" : "enabled" };
}

export async function detectPackages(sh) {
    const disabled = new Set(packageNames(await sh("pm list packages -d --user 0")));
    const third = new Set(packageNames(await sh("pm list packages -3 -u")));
    const installers = new Map();
    for (const line of lines(await sh("pm list packages -i --user 0"))) {
        const match = INSTALLER_LINE.exec(line);
        if (match && match[2] !== "null") {
            installers.set(match[1], match[2]);
        }
    }
    const running = new Set((await sh("ps -A -o NAME=")).split(/\s+/).filter((token) => token.includes(".")));

    const roles = new Map();
    for (const [role, query] of ROLE_QUERIES) {
        for (const pkg of await rolePackages(sh, query)) {
            if (!roles.has(pkg)) {
                roles.set(pkg, new Set());
            }
            roles.get(pkg).add(role);
        }
    }
    const overlays = await overlayTargets(sh);

    const detected = [];
    for (const line of lines(await sh("pm list packages -f -U -u --user 0"))) {
        const match = PACKAGE_LINE.exec(line);
        if (!match) {
            continue;
        }
        const [, path, pkg, uid] = match;
        const apk = apkName(path);
        const facts = classify({ path, package: pkg, uid }, { disabled, third, installers, running, roles, overlays });
        const noted = Object.hasOwn(KNOWN_NOTES, pkg) ? KNOWN_NOTES[pkg] : undefined;
        detected.push({
            package: pkg,
            label: apk,
            apk,
            partition: facts.partition,
            uid,
            roles: [...(roles.get(pkg) || [])].sort(),
            installer: installers.get(pkg) || "",
            running: running.has(pkg),
            state: facts.state,
            risk: facts.risk,
            reasons: facts.reasons,
            verdict: (noted && noted[0]) || "undocumented",
            note: (noted && noted[1]) || "",
        });
    }
    const rank = (row) => {
        const verdict = VERDICT_ORDER.indexOf(row.verdict);
        return [verdict === -1 ? 9 : verdict, RISK_ORDER.indexOf(row.risk), row.package];
    };
    detected.sort((a, b) => {
        const left = rank(a);
        const right = rank(b);
        for (let i = 0; i < left.length; i += 1) {
            if (left[i] !== right[i]) {
                return left[i] < right[i] ? -1 : 1;
            }
        }
        return 0;
    });
    return detected;
}

const PROPS = {
    model: "ro.product.model",
    release: "ro.build.version.release",
    sdk: "ro.build.version.sdk",
    abi: "ro.product.cpu.abi",
    product: "ro.product.name",
    hardware: "ro.hardware",
    board: "ro.product.board",
    build: "ro.build.display.id",
};

export async function deviceInfo(sh) {
    // `adb shell` joins its arguments into one string for /system/bin/sh on the TV, so `;` really does
    // chain these. getprop prints one line per key (empty when unset), which keeps positions aligned.
    const props = Object.values(PROPS);
    const values = (await sh(props.map((prop) => `getprop ${prop}`).join("; "))).split("\n");
    const info = {};
    Object.keys(PROPS).forEach((name, index) => {
        info[name] = (values[index] || "").trim();
    });
    return info;
}
