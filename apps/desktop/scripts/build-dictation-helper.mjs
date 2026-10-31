// Builds the on-device recogniser the dictation window talks to: `whisper-cli` from whisper.cpp,
// at one pinned commit, statically linked so the helper is a single file (Metal shaders embedded
// on Apple Silicon). Output: `helper/<os>-<arch>/whisper-cli[.exe]` plus the licence texts, where
// `<os>` and `<arch>` are electron-builder's `${os}` and `${arch}` (mac, linux, win; x64, arm64):
// `electron-builder.yml` packs that folder as `extraResources`, and `src/dictation/index.ts` reads it in a dev run.
//
//   node scripts/build-dictation-helper.mjs [--work <dir>] [--arch x64|arm64] [--max-glibc 2.35]
//
// `--arch` builds for the other architecture of the same OS (Windows only; the result cannot run here, so the
// start-up check is skipped). `--max-glibc` fails a Linux build that needs a newer glibc than that: the release
// builds on the oldest runner it ships from, so a helper that links against a newer one never reaches users.
//
// Needs git, cmake and a C++ toolchain; Windows on arm64 needs the "C++ Clang tools for Windows" component (clang-cl).
// The same pin is used by the benchmark in plans/desktop-dictation.md (Appendix A), so the shipped build is the one that was measured.
//
// CPU floor. `GGML_NATIVE=OFF` stops ggml tuning for the build machine, but on x64 it still enables the AVX2 family
// (AVX2, FMA, F16C, BMI2), so a CPU older than Haswell (2013) or an AMD one older than Excavator dies with SIGILL at
// start; dictation reports that as a helper error. ARM builds target armv8.2-a with half-precision and dot-product
// instructions (Cortex-A75 and later). Nothing detects an older CPU at run time; the plan lists both floors.
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// whisper.cpp v1.9.5.
const WHISPER_CPP_SHA = "d1be6fde11ac6e0407606b4e42fe72d34add8037";
const WHISPER_CPP_URL = "https://github.com/ggml-org/whisper.cpp.git";
// The oldest macOS the app runs on: Electron 44's own LSMinimumSystemVersion. The helper must not require more.
const MACOS_MINIMUM = "13.0";

const root = fileURLToPath(new URL("..", import.meta.url));
const flagValue = (name) => {
    const index = process.argv.indexOf(name);

    return index === -1 ? undefined : process.argv[index + 1];
};
const targetArch = flagValue("--arch") ?? process.arch;
const work =
    flagValue("--work") === undefined
        ? path.join(os.tmpdir(), `neore-whisper.cpp-${WHISPER_CPP_SHA.slice(0, 12)}-${targetArch}`)
        : path.resolve(flagValue("--work"));
const executable = process.platform === "win32" ? "whisper-cli.exe" : "whisper-cli";
const builderOs = { darwin: "mac", linux: "linux", win32: "win" }[process.platform];

if (builderOs === undefined) {
    throw new Error(`no helper build for ${process.platform}`);
}

if (!["arm64", "x64"].includes(targetArch)) {
    throw new Error(`no helper build for ${targetArch}`);
}

if (targetArch !== process.arch && process.platform !== "win32") {
    throw new Error("--arch other than the machine's own is supported on Windows only");
}

const outDirectory = path.join(root, "helper", `${builderOs}-${targetArch}`);

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

/** The names of the DLLs a PE file imports: the NT headers' import directory, read without a Windows toolchain. */
const peImports = (file) => {
    const peOffset = file.readUInt32LE(0x3c);
    const sectionCount = file.readUInt16LE(peOffset + 6);
    const optionalSize = file.readUInt16LE(peOffset + 20);
    const optional = peOffset + 24;
    // The import directory is the second data directory; PE32+ (0x20b) keeps them 16 bytes later than PE32.
    const directory = optional + (file.readUInt16LE(optional) === 0x20b ? 120 : 104);
    const importRva = file.readUInt32LE(directory);
    const sections = Array.from({ length: sectionCount }, (_, index) => {
        const at = optional + optionalSize + index * 40;

        return {
            rawPointer: file.readUInt32LE(at + 20),
            size: Math.max(file.readUInt32LE(at + 8), file.readUInt32LE(at + 16)),
            virtualAddress: file.readUInt32LE(at + 12),
        };
    });
    const toOffset = (rva) => {
        const section = sections.find(({ size, virtualAddress }) => rva >= virtualAddress && rva < virtualAddress + size);

        if (section === undefined) {
            throw new Error("the helper's import table points outside its sections");
        }

        return rva - section.virtualAddress + section.rawPointer;
    };
    const names = [];

    if (importRva === 0) {
        return names;
    }

    // One 20-byte descriptor per DLL, ended by an all-zero one; the name's RVA is its fourth field.
    for (let at = toOffset(importRva); file.readUInt32LE(at + 12) !== 0; at += 20) {
        const start = toOffset(file.readUInt32LE(at + 12));

        names.push(file.toString("latin1", start, file.indexOf(0, start)));
    }

    return names;
};

/**
 * The CMake generator for the Visual Studio this machine has: the runner images move on (VS 2022, then 2026), and CMake only knows a
 * generator by a name that carries the version, so a fixed one stops working the day the image changes.
 */
const visualStudioGenerator = () => {
    if (process.env.NEORE_CMAKE_GENERATOR !== undefined) {
        return process.env.NEORE_CMAKE_GENERATOR;
    }

    const vswhere = path.join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Microsoft Visual Studio", "Installer", "vswhere.exe");
    const version = existsSync(vswhere)
        ? execFileSync(
              vswhere,
              [
                  "-latest",
                  "-prerelease",
                  "-products",
                  "*",
                  "-requires",
                  "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
                  "-property",
                  "installationVersion",
              ],
              { encoding: "utf8" },
          ).trim()
        : "";
    const generator = { 17: "Visual Studio 17 2022", 18: "Visual Studio 18 2026" }[Number.parseInt(version, 10)];

    if (generator === undefined) {
        throw new Error(`no Visual Studio with the C++ tools was found (vswhere reported "${version}"); set NEORE_CMAKE_GENERATOR`);
    }

    process.stdout.write(`using the ${generator} generator\n`);

    return generator;
};

const flags = [
    "-DCMAKE_BUILD_TYPE=Release",
    // One file to ship and sign: no libwhisper/libggml next to it.
    "-DBUILD_SHARED_LIBS=OFF",
    "-DWHISPER_BUILD_TESTS=OFF",
    "-DWHISPER_BUILD_EXAMPLES=ON",
    // The default tunes for the build machine's own CPU (`-mcpu=native`), which dies with SIGILL on an older chip of the same family.
    "-DGGML_NATIVE=OFF",
];

if (process.platform === "darwin") {
    // Metal on Apple Silicon, with its shader library compiled in; the Intel build runs on the CPU
    // (its GPU is slower than the CPU on the machines measured, plans/desktop-dictation.md Appendix A).
    flags.push(
        process.arch === "arm64" ? "-DGGML_METAL_EMBED_LIBRARY=ON" : "-DGGML_METAL=OFF",
        `-DCMAKE_OSX_DEPLOYMENT_TARGET=${MACOS_MINIMUM}`,
        `-DCMAKE_OSX_ARCHITECTURES=${process.arch === "arm64" ? "arm64" : "x86_64"}`,
    );
}

// OpenMP is a runtime we cannot ship inside one file (vcomp140.dll, libgomp.so), and ggml's own thread pool does the same work.
if (process.platform !== "darwin") {
    flags.push("-DGGML_OPENMP=OFF");
}

// Without `-DGGML_NATIVE=ON` ggml targets bare armv8-a on ARM, which has no half-precision or dot-product instructions and runs
// the model several times slower. This floor is Cortex-A75/A55 (2017) and everything after it, which covers every Windows on
// ARM device and the Linux servers and boards that matter. An older core (a Raspberry Pi 4) dies with SIGILL, which dictation
// reports as an error from the helper, like any other crash.
const ARM_BASELINE = "armv8.2-a+fp16+dotprod";

if (process.platform !== "darwin" && targetArch === "arm64") {
    flags.push(`-DGGML_CPU_ARM_ARCH=${ARM_BASELINE}`);
}

if (process.platform === "win32") {
    // whisper.cpp asks for CMake 3.5, so the runtime-library variable is ignored (CMP0091 is OLD) and the helper links the DLL
    // runtime (msvcp140, vcruntime140) that a clean Windows install lacks: the policy has to be set before the project reads it.
    flags.push("-DCMAKE_POLICY_DEFAULT_CMP0091=NEW", "-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded");
    // ggml refuses to build for ARM with MSVC unless it may tune for the build machine (`GGML_NATIVE=ON`), which this build never
    // does: arm64 goes through clang-cl, which takes the baseline above. x64 builds with MSVC proper. The architecture and the
    // toolset are options of the Visual Studio generator, so no developer prompt has to be open.
    flags.push("-G", visualStudioGenerator(), "-A", targetArch === "arm64" ? "ARM64" : "x64");

    if (targetArch === "arm64") {
        flags.push("-T", "ClangCL");
    }
}

if (process.platform === "linux") {
    // A helper that needs the build machine's libstdc++ or libgcc runtime would not start on a minimal system.
    flags.push("-DCMAKE_EXE_LINKER_FLAGS=-static-libstdc++ -static-libgcc");
}

run("cmake", ["-B", "build", ...flags], work);
const buildArgs = ["--build", "build", "--config", "Release", "--target", "whisper-cli", "-j", String(Math.max(1, os.availableParallelism()))];

if (process.platform !== "darwin" && targetArch === "arm64") {
    // clang-cl drops an option it does not know with a warning, and a build without the ARM baseline is several times slower
    // while looking fine: read its output for that warning.
    // The compiler's warnings go to stderr as often as to stdout: both are read, and both are echoed even when the build fails.
    const build = spawnSync("cmake", buildArgs, { cwd: work, encoding: "utf8", maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "pipe"] });

    process.stdout.write(build.stdout ?? "");
    process.stderr.write(build.stderr ?? "");

    if (build.error !== undefined) {
        throw build.error;
    }

    if (build.status !== 0) {
        throw new Error(`cmake --build exited with ${String(build.status ?? build.signal)}`);
    }

    if (/unknown argument ignored in clang-cl: '-march/u.test(`${build.stdout}\n${build.stderr}`)) {
        throw new Error(`the compiler ignored -march=${ARM_BASELINE}; the helper would run on bare armv8-a`);
    }
} else {
    run("cmake", buildArgs, work);
}

const built = [path.join(work, "build", "bin", executable), path.join(work, "build", "bin", "Release", executable)].find((candidate) => existsSync(candidate));

if (built === undefined) {
    throw new Error(`whisper-cli was not built under ${path.join(work, "build")}`);
}

// Checked on the build output, before anything is copied to where electron-builder packs from.
if (process.platform === "darwin") {
    const loadCommands = execFileSync("otool", ["-l", built], { encoding: "utf8" });
    // LC_BUILD_VERSION names it `minos`; the older LC_VERSION_MIN_MACOSX names it `version`.
    const minimum = /LC_BUILD_VERSION[\s\S]*?minos (\S+)|LC_VERSION_MIN_MACOSX[\s\S]*?version (\S+)/.exec(loadCommands);
    const found = minimum?.[1] ?? minimum?.[2];

    if (found === undefined) {
        throw new Error("otool reported no minimum macOS version for the helper");
    }

    const [foundMajor = 0, foundMinor = 0] = found.split(".").map(Number);
    const [allowedMajor = 0, allowedMinor = 0] = MACOS_MINIMUM.split(".").map(Number);

    if (foundMajor > allowedMajor || (foundMajor === allowedMajor && foundMinor > allowedMinor)) {
        throw new Error(`the helper needs macOS ${found}, above the app's minimum ${MACOS_MINIMUM}`);
    }
}

if (process.platform === "linux") {
    // Only the C library and what ships with it: anything else (libgomp, libstdc++) may be absent on the user's machine.
    const needed = [...execFileSync("readelf", ["-d", built], { encoding: "utf8" }).matchAll(/\(NEEDED\)\s+Shared library: \[([^\]]+)\]/gu)].map(
        (match) => match[1],
    );
    const unexpected = needed.filter((library) => !/^(?:ld-linux[\w.-]*|libc|libdl|libm|libpthread|librt)\.so(?:\.\d+)*$/u.test(library));

    if (unexpected.length > 0) {
        throw new Error(`the helper depends on ${unexpected.join(", ")}, which a user's machine may not have`);
    }

    const maxGlibc = flagValue("--max-glibc");
    const symbols = execFileSync("objdump", ["-T", built], { encoding: "utf8" });
    const versions = [...symbols.matchAll(/GLIBC_(\d+)\.(\d+)/gu)].map((match) => [Number(match[1]), Number(match[2])]);
    const [newestMajor = 0, newestMinor = 0] = versions.sort((a, b) => b[0] - a[0] || b[1] - a[1])[0] ?? [];

    process.stdout.write(`the helper needs glibc ${newestMajor}.${newestMinor}\n`);

    if (maxGlibc !== undefined) {
        const [allowedMajor = 0, allowedMinor = 0] = maxGlibc.split(".").map(Number);

        if (newestMajor > allowedMajor || (newestMajor === allowedMajor && newestMinor > allowedMinor)) {
            throw new Error(`the helper needs glibc ${newestMajor}.${newestMinor}, above the ${maxGlibc} the release is built for`);
        }
    }
}

if (process.platform === "win32") {
    // The static C++ runtime is linked in; what is left must be DLLs every Windows has. A Visual C++ redistributable DLL
    // (vcruntime140, msvcp140, vcomp140) is not on a clean machine.
    const imports = peImports(readFileSync(built));
    const unexpected = imports.filter((library) => /^(?:concrt|msvcp|vcomp|vcruntime)/iu.test(library));

    if (unexpected.length > 0) {
        throw new Error(`the helper imports ${unexpected.join(", ")}, which a clean Windows install does not have`);
    }
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

// `--help` exits 0 only if the binary starts, so a bad link fails here and not on the first dictation. A cross-built binary cannot run here.
if (targetArch === process.arch) {
    run(path.join(outDirectory, executable), ["--help"], root);
}

process.stdout.write(`built ${path.join(outDirectory, executable)}\n`);
