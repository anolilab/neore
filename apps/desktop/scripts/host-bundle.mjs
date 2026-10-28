// Builds the `neore-host` binaries the desktop uploads to servers (plans/ssh-environments.md §8) and the manifest
// of their SHA-256 checksums, into `host-bundle/`. electron-builder ships that folder as `resources/neore-host`.
//
//   node scripts/host-bundle.mjs build <rust-target>...   build, check and copy binaries
//   node scripts/host-bundle.mjs manifest [--allow-partial]   hash what is in host-bundle/ and write manifest.json
//
// The host holds no pairing, so it must link no keyring (and on Linux no libdbus): every build here passes
// `--no-default-features`, and refuses to continue if the crate's dependency tree for the target still has one.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
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
        // A static binary runs on any distribution. `file` exists on the Linux runners; elsewhere there is no one to ask.
        try {
            const described = execFileSync("file", ["-b", built], { encoding: "utf8" });

            if (!/statically linked|static-pie linked/.test(described)) {
                fail(`${built} is not statically linked: ${described.trim()}`);
            }
        } catch (error) {
            if (error?.code !== "ENOENT") {
                throw error;
            }
        }
    }

    mkdirSync(bundle, { recursive: true });
    copyFileSync(built, path.join(bundle, binaryName(triple)));
    console.log(`host-bundle: ${triple} ok`);
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
} else if (command === "manifest") {
    manifest(rest.includes("--allow-partial"));
} else {
    fail("usage: host-bundle.mjs build <rust-target>... | manifest [--allow-partial]");
}
