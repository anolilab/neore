#!/usr/bin/env node
/**
 * Builds the Rust Worker: `worker-build --release`, then drops the wasm name
 * section worker-build keeps (it always passes `--debuginfo` to wasm-opt —
 * ~3 MB on this module). Output: `build/index.js` + `build/index_bg.wasm`
 * (what `wrangler.jsonc#main`, the workerd suite and `alchemy.run.ts` load).
 *
 * Paths resolve from THIS file, never from the cwd: the build is started from
 * different places — `lunora dev` (from this service's folder, since
 * anolilab/lunora#934 was fixed), CI and the deploy (from the repo root) — so
 * `wrangler.jsonc` calls `pnpm --filter document-parser run build:worker`,
 * which pnpm runs here whatever the caller's cwd.
 *
 * Up to date = skipped: when `build/` is newer than every input (the Rust
 * sources, Cargo.toml/.lock, .cargo/config.toml, this script), nothing runs —
 * `lunora dev` calls this on every start, and even a no-op `worker-build`
 * re-runs wasm-bindgen and wasm-opt over the whole module. `--force` rebuilds.
 *
 * Toolchain (docs/plans/document-parser.md has the details):
 *   rustup target add wasm32-unknown-unknown
 *   cargo install worker-build --version 0.8.7 --locked
 * worker-build downloads wasm-bindgen (matching Cargo.lock), wasm-opt and
 * esbuild into ~/.cache/worker-build itself. Where that download is blocked,
 * install them and they are picked up from PATH / ~/.cargo/bin — or point
 * WASM_BINDGEN_BIN / WASM_OPT_BIN / ESBUILD_BIN at them explicitly.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const executable = process.platform === "win32" ? ".exe" : "";
const outputs = ["build/index.js", "build/index_bg.wasm"].map((file) => join(packageDir, file));

/** Every file the build reads: newest mtime wins. */
const newestInput = () => {
    const files = [
        join(packageDir, "Cargo.toml"),
        join(packageDir, "Cargo.lock"),
        join(packageDir, ".cargo", "config.toml"),
        fileURLToPath(import.meta.url),
        ...readdirSync(join(packageDir, "src"), { recursive: true, withFileTypes: true })
            .filter((entry) => entry.isFile())
            .map((entry) => join(entry.parentPath, entry.name)),
    ];

    return Math.max(...files.filter((file) => existsSync(file)).map((file) => statSync(file).mtimeMs));
};

if (
    !process.argv.includes("--force") &&
    outputs.every((file) => existsSync(file)) &&
    Math.min(...outputs.map((file) => statSync(file).mtimeMs)) > newestInput()
) {
    console.log("document-parser: build/ is up to date (pass --force to rebuild).");
    process.exit(0);
}

/** The first `name` on PATH or in ~/.cargo/bin. */
const findOnPath = (name) => {
    const directories = [...(process.env.PATH ?? "").split(delimiter), join(homedir(), ".cargo", "bin")];

    for (const directory of directories) {
        const candidate = join(directory, name + executable);

        if (directory && existsSync(candidate)) {
            return candidate;
        }
    }

    return undefined;
};

const versionOf = (binary) => {
    try {
        return execFileSync(binary, ["--version"], { encoding: "utf8" }).trim();
    } catch {
        return "";
    }
};

/** The wasm-bindgen crate version Cargo.lock pins — the CLI must match it exactly. */
const lockedWasmBindgen = () => /\[\[package\]\]\nname = "wasm-bindgen"\nversion = "([^"]+)"/u.exec(readFileSync(join(packageDir, "Cargo.lock"), "utf8"))?.[1];

const env = { ...process.env };

if (!env.WASM_BINDGEN_BIN) {
    const local = findOnPath("wasm-bindgen");
    const locked = lockedWasmBindgen();

    // A mismatched CLI fails the build; worker-build then downloads the right one.
    if (local && locked && versionOf(local).endsWith(` ${locked}`)) {
        env.WASM_BINDGEN_BIN = local;
    }
}

env.WASM_OPT_BIN ||= findOnPath("wasm-opt") ?? "";
// The repo's own esbuild (a devDependency) — the exact version worker-build 0.8.7 wants.
env.ESBUILD_BIN ||=
    [join(packageDir, "node_modules", ".bin", `esbuild${process.platform === "win32" ? ".cmd" : ""}`)].find((candidate) => existsSync(candidate)) ?? "";

for (const key of ["WASM_BINDGEN_BIN", "WASM_OPT_BIN", "ESBUILD_BIN"]) {
    if (!env[key]) {
        delete env[key];
    }
}

const workerBuild = findOnPath("worker-build");

if (!workerBuild) {
    console.error(
        "worker-build not found. Install the Rust toolchain, then:\n  rustup target add wasm32-unknown-unknown\n  cargo install worker-build --version 0.8.7 --locked",
    );
    process.exit(1);
}

const built = spawnSync(workerBuild, ["--release"], { cwd: packageDir, env, stdio: "inherit" });

if (built.status !== 0) {
    process.exit(built.status ?? 1);
}

/** wasm-opt for the name-section strip: the configured/installed one, else the copy worker-build downloaded. */
const wasmOpt = (() => {
    if (env.WASM_OPT_BIN) {
        return env.WASM_OPT_BIN;
    }

    const cache = join(process.env.XDG_CACHE_HOME ?? join(homedir(), process.platform === "darwin" ? "Library/Caches" : ".cache"), "worker-build");

    if (!existsSync(cache)) {
        return undefined;
    }

    for (const entry of readdirSync(cache).filter((name) => name.startsWith("wasm-opt-"))) {
        for (const relative of [join("bin", "wasm-opt"), join("binaryen-version_132", "bin", "wasm-opt")]) {
            const candidate = join(cache, entry, relative + executable);

            if (existsSync(candidate)) {
                return candidate;
            }
        }
    }

    return undefined;
})();

const wasm = join(packageDir, "build", "index_bg.wasm");

if (wasmOpt) {
    const stripped = spawnSync(
        wasmOpt,
        [
            wasm,
            "-o",
            wasm,
            "--strip-debug",
            "--enable-mutable-globals",
            "--enable-sign-ext",
            "--enable-nontrapping-float-to-int",
            "--enable-bulk-memory",
            "--enable-multivalue",
            "--enable-reference-types",
            "--enable-exception-handling",
        ],
        { stdio: "inherit" },
    );

    if (stripped.status !== 0) {
        process.exit(stripped.status ?? 1);
    }
} else {
    console.warn("wasm-opt not found: the name section stays in (~3 MB larger, still far under the 64 MiB limit).");
}

const mib = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;

console.log(
    `document-parser: build/index_bg.wasm ${mib(statSync(wasm).size)} (${mib(gzipSync(readFileSync(wasm)).length)} gzip); Workers limit 64 MiB uncompressed.`,
);
