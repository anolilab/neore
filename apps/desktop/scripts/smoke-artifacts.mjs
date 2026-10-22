// Packaging smoke test for the release directory: the installer for this platform, the
// unpacked app with its device-execution addon outside the asar, and the update feed exist.
// Run after `electron-builder` (see the `smoke:artifacts` script and desktop.yml).
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const release = path.join(fileURLToPath(new URL("..", import.meta.url)), "release");

const fail = (message) => {
    console.error(`smoke-artifacts: ${message}`);
    process.exit(1);
};

if (!existsSync(release)) {
    fail(`no release directory at ${release}; run electron-builder first`);
}

const installers = {
    darwin: [/\.(dmg|zip)$/i],
    win32: [/\.exe$/i],
    linux: [/\.AppImage$/i, /\.deb$/i],
};

const names = readdirSync(release);
const patterns = installers[process.platform];

if (!patterns) {
    fail(`no installer rules for platform ${process.platform}`);
}

for (const pattern of patterns) {
    if (!names.some((name) => pattern.test(name))) {
        fail(`no installer matching ${pattern} in ${release} (found: ${names.join(", ") || "nothing"})`);
    }
}

// Every packaged arch has an `app.asar.unpacked` (`*-unpacked` on Windows and Linux,
// `*.app/Contents/Resources` on macOS). The addon is listed in asarUnpack, so a `.node`
// file must sit inside it. Looks at most five levels down, and does not descend into it.
const findUnpacked = (dir, depth = 0) => {
    if (depth > 5) {
        return [];
    }

    return readdirSync(dir).flatMap((name) => {
        const full = path.join(dir, name);

        if (!statSync(full).isDirectory()) {
            return [];
        }

        return name === "app.asar.unpacked" ? [full] : findUnpacked(full, depth + 1);
    });
};

const hasNodeFile = (dir) => readdirSync(dir, { recursive: true }).some((entry) => String(entry).endsWith(".node"));

const unpacked = findUnpacked(release);

if (unpacked.length === 0) {
    fail(`no app.asar.unpacked directory under ${release}`);
}

for (const dir of unpacked) {
    if (!hasNodeFile(dir)) {
        fail(`no .node addon in ${dir}; asarUnpack did not pick it up`);
    }
}

if (!names.some((name) => /^latest.*\.yml$/.test(name))) {
    fail(`no latest*.yml update feed in ${release}`);
}

console.log(`smoke-artifacts: ok (${process.platform}: installer, ${unpacked.length} unpacked app(s), update feed)`);
