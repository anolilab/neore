// Builds the on-device recogniser the dictation window talks to: `whisper-cli` from whisper.cpp,
// at one pinned commit, statically linked so the helper is a single file (Metal shaders embedded
// on Apple Silicon). Output: `helper/<os>-<arch>/whisper-cli[.exe]` plus the licence texts, where
// `<os>` and `<arch>` are electron-builder's `${os}` and `${arch}` (mac, linux, win; x64, arm64):
// `electron-builder.yml` packs that folder as `extraResources`, and `src/dictation/index.ts` reads it in a dev run.
//
//   node scripts/build-dictation-helper.mjs [--work <dir>]
//
// Needs git, cmake and a C++ toolchain. The same pin is used by the benchmark in
// plans/desktop-dictation.md (Appendix A), so the shipped build is the one that was measured.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// whisper.cpp v1.9.5.
const WHISPER_CPP_SHA = "d1be6fde11ac6e0407606b4e42fe72d34add8037";
const WHISPER_CPP_URL = "https://github.com/ggml-org/whisper.cpp.git";

const root = fileURLToPath(new URL("..", import.meta.url));
const workFlag = process.argv.indexOf("--work");
const work = workFlag === -1 ? path.join(os.tmpdir(), `neore-whisper.cpp-${WHISPER_CPP_SHA.slice(0, 12)}`) : path.resolve(process.argv[workFlag + 1]);
const executable = process.platform === "win32" ? "whisper-cli.exe" : "whisper-cli";
const builderOs = { darwin: "mac", linux: "linux", win32: "win" }[process.platform];

if (builderOs === undefined) {
    throw new Error(`no helper build for ${process.platform}`);
}

const outDirectory = path.join(root, "helper", `${builderOs}-${process.arch}`);

const run = (command, args, cwd) => {
    execFileSync(command, args, { cwd, stdio: "inherit" });
};

if (!existsSync(path.join(work, ".git"))) {
    rmSync(work, { force: true, recursive: true });
    mkdirSync(work, { recursive: true });
    run("git", ["init", "-q"], work);
    run("git", ["remote", "add", "origin", WHISPER_CPP_URL], work);
}

run("git", ["fetch", "-q", "--depth", "1", "origin", WHISPER_CPP_SHA], work);
run("git", ["checkout", "-q", "--force", WHISPER_CPP_SHA], work);

const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: work, encoding: "utf8" }).trim();

if (head !== WHISPER_CPP_SHA) {
    throw new Error(`whisper.cpp checked out ${head}, expected ${WHISPER_CPP_SHA}`);
}

const flags = [
    "-DCMAKE_BUILD_TYPE=Release",
    // One file to ship and sign: no libwhisper/libggml next to it.
    "-DBUILD_SHARED_LIBS=OFF",
    "-DWHISPER_BUILD_TESTS=OFF",
    "-DWHISPER_BUILD_EXAMPLES=ON",
];

if (process.platform === "darwin") {
    // Metal on Apple Silicon, with its shader library compiled in; the Intel build runs on the CPU
    // (its GPU is slower than the CPU on the machines measured, plans/desktop-dictation.md Appendix A).
    flags.push(process.arch === "arm64" ? "-DGGML_METAL_EMBED_LIBRARY=ON" : "-DGGML_METAL=OFF");
}

if (process.platform === "win32") {
    flags.push("-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded");
}

run("cmake", ["-B", "build", ...flags], work);
run("cmake", ["--build", "build", "--config", "Release", "--target", "whisper-cli", "-j", String(Math.max(1, os.availableParallelism()))], work);

const built = [path.join(work, "build", "bin", executable), path.join(work, "build", "bin", "Release", executable)].find((candidate) => existsSync(candidate));

if (built === undefined) {
    throw new Error(`whisper-cli was not built under ${path.join(work, "build")}`);
}

// The committed licence text must still be the one the pinned source ships.
const shipped = path.join(root, "dictation-licenses", "whisper.cpp-LICENSE.txt");

if (readFileSync(path.join(work, "LICENSE"), "utf8") !== readFileSync(shipped, "utf8")) {
    throw new Error(`${shipped} differs from the LICENSE of whisper.cpp ${WHISPER_CPP_SHA}`);
}

rmSync(outDirectory, { force: true, recursive: true });
mkdirSync(path.join(outDirectory, "licenses"), { recursive: true });
copyFileSync(built, path.join(outDirectory, executable));

for (const file of ["whisper.cpp-LICENSE.txt", "whisper-model-LICENSE.txt"]) {
    copyFileSync(path.join(root, "dictation-licenses", file), path.join(outDirectory, "licenses", file));
}

// `--help` exits 0 only if the binary starts, so a bad link fails here and not on the first dictation.
run(path.join(outDirectory, executable), ["--help"], root);
process.stdout.write(`built ${path.join(outDirectory, executable)}\n`);
