import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseTranscript, startRecognizer } from "./recognizer.js";

const FAKE = fileURLToPath(new URL("../../e2e/fixtures/fake-whisper-cli.mjs", import.meta.url));
const helper = { args: [FAKE], command: process.execPath };
const pcm = (samples: number): Buffer => Buffer.alloc(samples * 2, 1);

let directory: string;
let model: string;

beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "neore-recognizer-"));
    model = path.join(directory, "model.bin");
    await writeFile(model, "weights");
});

afterEach(async () => {
    await rm(directory, { force: true, recursive: true });
});

describe("parseTranscript", () => {
    it("keeps one segment per line and joins them", () => {
        expect(parseTranscript(" Hello there.\n And more.\n")).toStrictEqual({ segments: ["Hello there.", "And more."], text: "Hello there. And more." });
    });

    it.each(["[BLANK_AUDIO]", "(music)", "[Music]", "*applause*", " [BLANK_AUDIO] \n\n"])("treats %j as silence", (output) => {
        expect(parseTranscript(output)).toStrictEqual({ segments: [], text: "" });
    });

    it("keeps speech that merely contains a parenthesis", () => {
        expect(parseTranscript("Call me (maybe) tomorrow.").text).toBe("Call me (maybe) tomorrow.");
    });

    it("keeps multi-byte text intact", () => {
        expect(parseTranscript("こんにちは、世界。\n").text).toBe("こんにちは、世界。");
    });
});

describe("startRecognizer", () => {
    it("sends the audio to the helper as a 16 kHz mono WAV and returns its text", async () => {
        const recognizer = startRecognizer({ cwd: directory, helper, modelPath: model });
        const result = await recognizer.transcribe(pcm(8000));

        expect(result.segments).toStrictEqual(["Hello from the fake recogniser, 8000 samples.", "Second segment."]);
        expect(result.text).toBe("Hello from the fake recogniser, 8000 samples. Second segment.");
    });

    it("reports silence as an empty transcript", async () => {
        await writeFile(model, "blank");

        const result = await startRecognizer({ cwd: directory, helper, modelPath: model }).transcribe(pcm(8000));

        expect(result.text).toBe("");
    });

    it("tells the helper to detect the language and to write nothing to disk", async () => {
        const seen: string[] = [];
        const { spawn } = await import("node:child_process");

        const recognizer = startRecognizer({
            cwd: directory,
            helper,
            modelPath: model,
            spawn: (command, args, options) => {
                seen.push(...args);

                return spawn(command, args, options);
            },
        });

        await recognizer.transcribe(pcm(100));

        expect(seen.slice(seen.indexOf("-m"))).toStrictEqual(["-m", model, "-f", "-", "-otxt", "-nt", "-np", "-l", "auto"]);
        expect(seen.filter((argument) => argument.startsWith("-o") && argument !== "-otxt")).toStrictEqual([]);
    });

    it("rejects with `crashed`, not an unhandled error, when the helper is killed before the audio is written", async () => {
        const recognizer = startRecognizer({ cwd: directory, helper, modelPath: model });
        const early = new Promise<string>((resolve) => {
            recognizer.onEarlyExit((error) => resolve(error.code));
        });

        process.kill(recognizer.pid as number, "SIGKILL");

        expect(await early).toBe("crashed");
        await expect(recognizer.transcribe(pcm(8000))).rejects.toMatchObject({ code: "crashed" });
    });

    it("rejects with `crashed` when the helper dies while it holds the audio", async () => {
        await writeFile(model, "die");

        await expect(startRecognizer({ cwd: directory, helper, modelPath: model }).transcribe(pcm(8000))).rejects.toMatchObject({ code: "crashed" });
    });

    it("rejects with `failed` and keeps the engine's stderr for the log when the helper exits non-zero", async () => {
        await expect(startRecognizer({ cwd: directory, helper, modelPath: path.join(directory, "missing.bin") }).transcribe(pcm(8000))).rejects.toMatchObject({
            code: "failed",
            detail: expect.stringContaining("bad arguments"),
        });
    });

    it("rejects with `unavailable` when the helper is not installed", async () => {
        const recognizer = startRecognizer({ cwd: directory, helper: { args: [], command: path.join(directory, "no-such-helper") }, modelPath: model });
        const early = new Promise<string>((resolve) => {
            recognizer.onEarlyExit((error) => resolve(error.code));
        });

        expect(await early).toBe("unavailable");
        await expect(recognizer.transcribe(pcm(100))).rejects.toMatchObject({ code: "unavailable" });
    });

    it("kills a helper that does not answer in time", async () => {
        const script = path.join(directory, "hang.mjs");

        await writeFile(script, "setInterval(() => {}, 1000);\n");

        const recognizer = startRecognizer({ cwd: directory, helper: { args: [script], command: process.execPath }, modelPath: model, timeoutMs: 100 });

        await expect(recognizer.transcribe(pcm(100))).rejects.toMatchObject({ code: "timeout" });
    });

    it("gives the helper only the environment it needs", async () => {
        const script = path.join(directory, "env.mjs");

        await writeFile(script, "for await (const _ of process.stdin) {}\nprocess.stdout.write(Object.keys(process.env).join(' ') + '\\n');\n");
        process.env.NEORE_SECRET_FOR_TEST = "x";

        const result = await startRecognizer({ cwd: directory, helper: { args: [script], command: process.execPath }, modelPath: model }).transcribe(pcm(100));

        delete process.env.NEORE_SECRET_FOR_TEST;
        expect(result.text).toContain("PATH");
        expect(result.text).not.toContain("NEORE_SECRET_FOR_TEST");
    });

    it("kills the helper on request", async () => {
        const recognizer = startRecognizer({ cwd: directory, helper, modelPath: model });

        recognizer.kill();
        await expect(recognizer.transcribe(pcm(100))).rejects.toMatchObject({ code: "crashed" });
    });
});
