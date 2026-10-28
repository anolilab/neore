/**
 * The real `whisper-cli` through the real `startRecognizer`, on the OS CI runs it on. Every other test here uses a stand-in helper
 * that prints to stdout whatever the arguments say, so only this one can show that the shipped binary hands its text back
 * (on Windows it used to print it to the console) and how fast the build is. It runs only when CI gives it a built helper.
 *
 * Environment: `NEORE_WHISPER_CLI` is the built `whisper-cli`; `NEORE_WHISPER_CLIP` a 16 kHz mono WAV of speech (whisper.cpp's own
 * `samples/jfk.wav`); `NEORE_WHISPER_EXPECT` a word the clip says ("country"); `NEORE_WHISPER_MODELS` comma-separated `name=path`
 * model files, of which the one named `small` is the default model of every supported platform; `NEORE_DICTATION_EXPECT` is
 * `supported` or `unsupported`, as for `catalog.test.ts`.
 */
import { appendFileSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SAMPLE_RATE } from "./channels.js";
import { startRecognizer } from "./recognizer.js";

/**
 * "Too slow": the default model takes more than this many times the clip's own length on a four-core CI runner. The slowest build
 * S1 accepted (Linux arm64, small) took 0.84 times; the Windows arm64 build it rejected took 4.3. A supported platform must be inside
 * it; an unsupported one is only recorded, so the step summary says when it is safe to mark supported.
 */
const BUDGET = 1.5;

const cli = process.env.NEORE_WHISPER_CLI;
const clip = process.env.NEORE_WHISPER_CLIP;
const models = (process.env.NEORE_WHISPER_MODELS ?? "")
    .split(",")
    .filter((entry) => entry.includes("="))
    .map((entry) => [entry.slice(0, entry.indexOf("=")), entry.slice(entry.indexOf("=") + 1)] as const);

const pcmOf = (wav: Buffer): Buffer => wav.subarray(wav.indexOf("data") + 8);

describe.runIf(cli !== undefined && clip !== undefined && models.length > 0)("the real speech helper", () => {
    let directory: string;

    beforeAll(async () => {
        directory = await mkdtemp(path.join(os.tmpdir(), "neore-real-helper-"));
    });

    afterAll(async () => {
        await rm(directory, { force: true, recursive: true });
    });

    it.each(models)("recognises the clip with %s and hands the text back on stdout", { timeout: 300_000 }, async (name, modelPath) => {
        const pcm = pcmOf(readFileSync(clip as string));
        const clipSeconds = pcm.length / 2 / SAMPLE_RATE;
        const started = performance.now();
        const { text } = await startRecognizer({ cwd: directory, helper: { args: [], command: cli as string }, language: "en", modelPath }).transcribe(pcm);
        const seconds = (performance.now() - started) / 1000;
        const factor = seconds / clipSeconds;
        const inside = factor <= BUDGET;

        process.stdout.write(`real helper: ${os.platform()} ${os.arch()} ${name}: ${seconds.toFixed(1)} s for a ${clipSeconds.toFixed(1)} s clip (${factor.toFixed(2)}x, budget ${BUDGET}x)\n`);

        if (process.env.GITHUB_STEP_SUMMARY !== undefined) {
            appendFileSync(
                process.env.GITHUB_STEP_SUMMARY,
                `| ${os.platform()} ${os.arch()} | ${name} | ${seconds.toFixed(1)} s | ${clipSeconds.toFixed(1)} s | ${factor.toFixed(2)}x | ${inside ? "inside" : "outside"} |\n`,
            );
        }

        expect(text.toLowerCase()).toContain(process.env.NEORE_WHISPER_EXPECT ?? "");

        if (name === "small" && process.env.NEORE_DICTATION_EXPECT === "supported") {
            expect(factor, `the default model took ${factor.toFixed(2)} times the clip; this platform is too slow to be offered`).toBeLessThanOrEqual(BUDGET);
        }
    });
});
