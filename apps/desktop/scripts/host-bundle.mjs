// Builds the `neore-host` binaries the desktop uploads to servers (plans/ssh-environments.md §8) and the manifest
// of their SHA-256 checksums, into `host-bundle/`. electron-builder ships that folder as `resources/neore-host`.
//
//   node scripts/host-bundle.mjs build <rust-target>...   build, check and copy binaries
//   node scripts/host-bundle.mjs sign   Developer ID sign the macOS binaries (macOS only; skipped without CSC_LINK)
//   node scripts/host-bundle.mjs manifest [--allow-partial]   hash what is in host-bundle/ and write manifest.json
//
// The macOS binaries are signed BEFORE they are hashed, and `mac.signIgnore` in electron-builder.yml keeps the app
// signing from touching them: signing rewrites a Mach-O, so one signed after hashing no longer matches its checksum
// and the desktop (rightly) refuses to upload it.

// The host holds no pairing, so it must link no keyring (and on Linux no libdbus): every build here passes
// `--no-default-features`, and refuses to continue if the crate's dependency tree for the target still has one.
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Keep in step with `TARGETS` in packages/device-core/src/install.rs (the Rust side refuses any other name).
const TARGETS = ["aarch64-apple-darwin", "aarch64-unknown-linux-musl", "x86_64-apple-darwin", "x86_64-unknown-linux-musl"];

const root = fileURLToPath(new URL("..", import.meta.url));
const crate = path.join(root, "..", "..", "packages", "device-core");
const manifestPath = path.join(crate, "Cargo.toml");
const bundle = path.join(root, "host-bundle");

const fail = (message) => {
    console.error(`host-bundle: ${message}`);
    process.exit(1);
};

/** The crate version: the folder `~/.neore/host/<version>` the desktop installs into, so it must match the Rust side's `HOST_VERSION`. */
const crateVersion = () => {
    const match = /^\[package\][^[]*?^version\s*=\s*"([^"]+)"/ms.exec(readFileSync(manifestPath, "utf8"));

    if (!match) {
        fail(`no package version in ${manifestPath}`);
    }

    return match[1];
};

const binaryName = (triple) => `neore-host-${triple}`;

const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

/** Names in `cargo tree` output (`--prefix none`: one `name vX.Y.Z` per line) that a keyless host must not link. */
const forbiddenDependencies = (treeOutput) =>
    [...new Set(treeOutput.split("\n").map((line) => line.trim().split(" ")[0]))].filter(
        (name) => name === "keyring" || name === "dbus" || name === "libdbus-sys" || name === "secret-service",
    );

const cargo = (args) => execFileSync("cargo", args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });

const build = (triple) => {
    if (!TARGETS.includes(triple)) {
        fail(`${triple} is not a host target (${TARGETS.join(", ")})`);
    }

    const common = ["--manifest-path", manifestPath, "--no-default-features", "--target", triple];
    const linked = forbiddenDependencies(cargo(["tree", ...common, "-e", "normal", "--prefix", "none"]));

    if (linked.length > 0) {
        fail(`neore-host for ${triple} would link ${linked.join(", ")}; it must build with --no-default-features`);
    }

    cargo(["build", ...common, "--release", "--locked", "--bin", "neore-host"]);

    const built = path.join(crate, "target", triple, "release", "neore-host");

    if (!existsSync(built)) {
        fail(`cargo did not produce ${built}`);
    }

    if (triple.endsWith("linux-musl")) {
        // A static binary runs on any distribution. On Linux `file` must be there to say so; elsewhere (a cross build)
        // there is no one to ask.
        try {
            const described = execFileSync("file", ["-b", built], { encoding: "utf8" });

            if (!/statically linked|static-pie linked/.test(described)) {
                fail(`${built} is not statically linked: ${described.trim()}`);
            }
        } catch (error) {
            if (error?.code !== "ENOENT") {
                throw error;
            }

            if (process.platform === "linux") {
                fail(`cannot tell whether ${built} is statically linked: the \`file\` command is missing`);
            }
        }
    }

    mkdirSync(bundle, { recursive: true });
    copyFileSync(built, path.join(bundle, binaryName(triple)));
    console.log(`host-bundle: ${triple} ok`);
};

/** Signs the macOS binaries in `host-bundle/` with the Developer ID certificate in `CSC_LINK` (a path or base64 of the .p12), hardened runtime and timestamp, as notarization needs. */
const sign = () => {
    const link = process.env.CSC_LINK;

    if (!link) {
        console.log("host-bundle: CSC_LINK is not set, the macOS binaries stay unsigned");

        return;
    }

    if (process.platform !== "darwin") {
        fail("the macOS binaries can only be signed on macOS");
    }

    const binaries = TARGETS.filter((triple) => triple.endsWith("apple-darwin")).map((triple) => path.join(bundle, binaryName(triple)));

    for (const binary of binaries) {
        if (!existsSync(binary)) {
            fail(`${binary} is missing; build it first`);
        }
    }

    const scratch = mkdtempSync(path.join(tmpdir(), "neore-host-sign-"));
    const keychain = path.join(scratch, "sign.keychain-db");
    const password = randomUUID();
    const run = (command, args) => execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });

    try {
        const p12 = existsSync(link) ? link : path.join(scratch, "certificate.p12");

        if (p12 !== link) {
            writeFileSync(p12, Buffer.from(link, "base64"), { mode: 0o600 });
        }

        run("security", ["create-keychain", "-p", password, keychain]);
        run("security", ["set-keychain-settings", "-lut", "3600", keychain]);
        run("security", ["unlock-keychain", "-p", password, keychain]);
        run("security", ["import", p12, "-k", keychain, "-P", process.env.CSC_KEY_PASSWORD ?? "", "-T", "/usr/bin/codesign"]);
        run("security", ["set-key-partition-list", "-S", "apple-tool:,apple:", "-s", "-k", password, keychain]);

        const listed = run("security", ["find-identity", "-v", "-p", "codesigning", keychain]);
        const wanted = process.env.CSC_NAME;
        const identity = listed
            .split("\n")
            .map((line) => /^\s*\d+\) ([0-9A-F]{40}) "(.+)"/.exec(line))
            .find((found) => found && (wanted ? found[2].includes(wanted) : found[2].startsWith("Developer ID Application")));

        if (!identity) {
            fail(`no ${wanted ?? "Developer ID Application"} identity in the certificate`);
        }

        for (const binary of binaries) {
            run("codesign", ["--force", "--timestamp", "--options", "runtime", "--keychain", keychain, "--sign", identity[1], binary]);
            run("codesign", ["--verify", "--strict", binary]);
            console.log(`host-bundle: signed ${path.basename(binary)}`);
        }
    } finally {
        rmSync(scratch, { force: true, recursive: true });
    }
};

/** The manifest for `triples`, hashed from the binaries in `dir`. */
const renderManifest = (version, dir, triples) => ({
    targets: Object.fromEntries(triples.map((triple) => [triple, { file: binaryName(triple), sha256: sha256(path.join(dir, binaryName(triple))) }])),
    version,
});

const manifest = (allowPartial) => {
    const present = TARGETS.filter((triple) => existsSync(path.join(bundle, binaryName(triple))));
    const missing = TARGETS.filter((triple) => !present.includes(triple));

    if (missing.length > 0 && !allowPartial) {
        fail(`no binary for ${missing.join(", ")} in ${bundle} (found: ${readdirSync(bundle).join(", ") || "nothing"})`);
    }

    writeFileSync(path.join(bundle, "manifest.json"), `${JSON.stringify(renderManifest(crateVersion(), bundle, present), null, 4)}\n`);
    console.log(`host-bundle: manifest for ${present.join(", ")}`);
};

const [command, ...rest] = process.argv.slice(2);

if (command === "build" && rest.length > 0) {
    rest.forEach(build);
} else if (command === "sign") {
    sign();
} else if (command === "manifest") {
    manifest(rest.includes("--allow-partial"));
} else {
    fail("usage: host-bundle.mjs build <rust-target>... | sign | manifest [--allow-partial]");
}
