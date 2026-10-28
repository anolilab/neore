// Packaging smoke test for the release directory: the installer for this platform, the
// unpacked app with its device-execution addon outside the asar, and the update feed exist.
// Run after `electron-builder` (see the `smoke:artifacts` script and desktop.yml). With `--unpacked-only` (an
// `electron-builder --dir` run, which writes no installer and no feed) only the unpacked apps are checked.
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const release = path.join(fileURLToPath(new URL("..", import.meta.url)), "release");

const unpackedOnly = process.argv.includes("--unpacked-only");

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

for (const pattern of unpackedOnly ? [] : patterns) {
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

// The dictation helper (`scripts/build-dictation-helper.mjs`) sits next to `app.asar.unpacked`, outside the asar, with its licence
// texts: one folder for each arch the helper was built for. Where none was built (Windows on ARM is not offered), none is packed.
const helperRoot = path.join(fileURLToPath(new URL("..", import.meta.url)), "helper");
const built = existsSync(helperRoot) ? readdirSync(helperRoot).length : 0;
const packedHelpers = unpacked.map((dir) => path.join(path.dirname(dir), "dictation")).filter((dir) => existsSync(dir));

if (packedHelpers.length !== built) {
    fail(`${built} dictation helper(s) were built, and ${packedHelpers.length} were packed (${helperRoot})`);
}

for (const dir of packedHelpers) {
    const executable = process.platform === "win32" ? "whisper-cli.exe" : "whisper-cli";

    if (!existsSync(path.join(dir, executable)) || !existsSync(path.join(dir, "licenses", "whisper.cpp-LICENSE.txt"))) {
        fail(`${dir} lacks ${executable} or its licence text`);
    }

    if (process.platform !== "win32" && (statSync(path.join(dir, executable)).mode & 0o111) === 0) {
        fail(`${executable} in ${dir} is not executable; dictation could not start it`);
    }
}

// The terminal starts a shell through node-pty's `spawn-helper`, which must sit outside the asar and be
// executable. It is built on macOS only: Linux forks the shell itself, and Windows uses ConPTY.
// A `build/Release` copy of the addon is loaded in preference to the per-arch `prebuilds/`, and a local rebuild has
// the packaging machine's arch only, so the other arch of a macOS app would carry an addon it cannot load.
if (process.platform === "darwin") {
    for (const dir of unpacked) {
        const rebuilt = readdirSync(dir, { recursive: true }).filter((entry) => /node-pty[\\/]build[\\/]Release[\\/]/.test(String(entry)));

        if (rebuilt.length > 0) {
            fail(`node-pty was rebuilt for the packaging machine (${rebuilt[0]} in ${dir}); the app must use its per-arch prebuilds`);
        }

        const helpers = readdirSync(dir, { recursive: true }).filter((entry) => path.basename(String(entry)) === "spawn-helper");

        if (helpers.length === 0) {
            fail(`no node-pty spawn-helper in ${dir}; asarUnpack did not pick it up`);
        }

        for (const helper of helpers) {
            if ((statSync(path.join(dir, String(helper))).mode & 0o111) === 0) {
                fail(`${helper} in ${dir} is not executable; the terminal could not start a shell`);
            }
        }
    }
}

// On Windows the host loads node-pty from the unpacked copy: its worker script and the ConPTY binding must be there.
if (process.platform === "win32") {
    for (const dir of unpacked) {
        const files = readdirSync(dir, { recursive: true }).map((entry) => String(entry).replaceAll("\\", "/"));

        for (const needed of [
            "node-pty/lib/worker/conoutSocketWorker.js",
            "node-pty/prebuilds/win32-x64/conpty.node",
            "node-pty/prebuilds/win32-arm64/conpty.node",
        ]) {
            if (!files.some((file) => file.endsWith(needed))) {
                fail(`no ${needed} in ${dir}; asarUnpack did not pick it up, and the terminal could not start a shell`);
            }
        }
    }
}

if (!unpackedOnly && !names.some((name) => /^latest.*\.yml$/.test(name))) {
    fail(`no latest*.yml update feed in ${release}`);
}

console.log(
    `smoke-artifacts: ok (${process.platform}: ${unpackedOnly ? "" : "installer, "}${unpacked.length} unpacked app(s)${unpackedOnly ? "" : ", update feed"})`,
);
