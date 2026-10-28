/**
 * A whole dictation through the real controller, model store and recogniser (a stand-in `whisper-cli` as the helper process),
 * with the network refused and with scratch temp and app-data folders that are scanned afterwards.
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ModelSpec } from "./catalog.js";
import type { CaptureWindow } from "./controller.js";
import { createDictationController } from "./controller.js";
import { createModelStore } from "./model-store.js";
import { startRecognizer } from "./recognizer.js";

const FAKE = fileURLToPath(new URL("../../e2e/fixtures/fake-whisper-cli.mjs", import.meta.url));
/** Distinctive samples: if any file under the scanned folders holds them, the audio was written to disk. */
const FAKE_TRANSCRIPT = /^Hello from the fake recogniser, \d+ samples\. Second segment\.$/u;
const MARKER = Buffer.from("NEORE-AUDIO-MARKER-0123456789ABCDEF!!".repeat(64));
const WEIGHTS = Buffer.from("recognise");
const spec: ModelSpec = {
    bytes: WEIGHTS.length,
    file: "ggml-test.bin",
    id: "test",
    label: "Test",
    sha256: createHash("sha256").update(WEIGHTS).digest("hex"),
    url: "https://models.example/ggml-test.bin",
    version: "rev1",
};

const walk = async (directory: string): Promise<string[]> => {
    const found: string[] = [];

    const entries = await readdir(directory, { withFileTypes: true });

    for (const entry of entries) {
        const full = path.join(directory, entry.name);

        if (entry.isDirectory()) {
            found.push(...await walk(full));
        } else {
            found.push(full);
        }
    }

    return found;
};

let root: string;
let temporary: string;
let appData: string;
let previousTemporary: Record<string, string | undefined>;

beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "neore-dictation-it-"));
    temporary = path.join(root, "tmp");
    appData = path.join(root, "app-data");
    await Promise.all([mkdir(temporary), mkdir(path.join(appData, "dictation", "models"), { recursive: true })]);
    await writeFile(path.join(appData, "dictation", "models", spec.file), WEIGHTS);
    // The variables the helper is given and `os.tmpdir()` reads: TMPDIR on POSIX, TEMP and TMP on Windows.
    previousTemporary = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR };
    Object.assign(process.env, { TEMP: temporary, TMP: temporary, TMPDIR: temporary });
});

afterEach(async () => {
    for (const [name, value] of Object.entries(previousTemporary)) {
        if (value === undefined) {
            Reflect.deleteProperty(process.env, name);
        } else {
            process.env[name] = value;
        }
    }

    vi.restoreAllMocks();
    await rm(root, { force: true, maxRetries: 10, recursive: true, retryDelay: 100 });
});

const run = async (): Promise<{ inserted: string[]; notices: string[]; windowClosed: boolean }> => {
    const inserted: string[] = [];
    const notices: string[] = [];
    const window: CaptureWindow & { closed: boolean } = { close: () => {
        window.closed = true;
    }, closed: false, stop: async () => {} };
    const models = createModelStore({ directory: path.join(appData, "dictation", "models") });
    const controller = createDictationController({
        confirmDownload: async () => false,
        enabled: () => true,
        hasHelper: () => true,
        insert: (text) => {
            inserted.push(text);
        },
        log: () => {},
        microphoneAllowed: async () => true,
        model: () => spec,
        models,
        notify: (_title, body) => {
            notices.push(body);
        },
        now: () => Date.now(),
        openWindow: () => window,
        startRecognizer: (modelPath) =>
            startRecognizer({ cwd: path.join(appData, "dictation"), helper: { args: [FAKE], command: process.execPath }, language: "auto", modelPath }),
    });

    controller.press();
    await vi.waitFor(() => expect(controller.state()).toBe("recording"));
    controller.addAudio(MARKER);
    controller.addAudio(Buffer.alloc(32_000));
    controller.release();
    await vi.waitFor(() => expect(controller.state()).toBe("idle"));

    return { inserted, notices, windowClosed: window.closed };
};

describe("a dictation with the network refused", () => {
    it("completes and inserts the text", async () => {
        const attempts: unknown[] = [];

        vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
            attempts.push(input);
            throw new TypeError("network is blocked");
        });
        vi.spyOn(net.Socket.prototype, "connect").mockImplementation((...args: unknown[]) => {
            attempts.push(args);
            throw new Error("network is blocked");
        });

        const { inserted, notices, windowClosed } = await run();

        expect(inserted).toHaveLength(1);
        expect(inserted[0]).toMatch(FAKE_TRANSCRIPT);
        expect(notices).toStrictEqual([]);
        expect(windowClosed).toBe(true);
        expect(attempts).toStrictEqual([]);
    });
});

describe("with the switch off", () => {
    it("opens no window, downloads nothing and writes nothing, with the network watched", async () => {
        const attempts: unknown[] = [];

        vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
            attempts.push(input);
            throw new TypeError("network is blocked");
        });
        vi.spyOn(net.Socket.prototype, "connect").mockImplementation((...args: unknown[]) => {
            attempts.push(args);
            throw new Error("network is blocked");
        });

        const directory = path.join(appData, "dictation", "models");

        await rm(directory, { force: true, maxRetries: 10, recursive: true, retryDelay: 100 });

        const opened: unknown[] = [];
        const asked: unknown[] = [];
        const controller = createDictationController({
            confirmDownload: async (model) => {
                asked.push(model);

                return true;
            },
            enabled: () => false,
            hasHelper: () => true,
            insert: () => {},
            log: () => {},
            microphoneAllowed: async () => true,
            model: () => spec,
            models: createModelStore({ directory }),
            notify: () => {},
            now: () => Date.now(),
            openWindow: () => {
                opened.push(1);

                throw new Error("must not open");
            },
            startRecognizer: () => {
                throw new Error("must not start");
            },
        });

        controller.press();
        await vi.waitFor(() => expect(controller.lastOutcome()).toBe("disabled"));

        expect(opened).toStrictEqual([]);
        expect(asked).toStrictEqual([]);
        expect(attempts).toStrictEqual([]);
        expect(await walk(appData)).toStrictEqual([]);
    });
});

describe("after a dictation", () => {
    it("leaves no audio in the temp or the app data folder", async () => {
        const before = new Set([...await walk(temporary), ...await walk(appData)]);

        await run();

        const after = new Set([...await walk(temporary), ...await walk(appData)]);

        // Nothing was added, and nothing that is there holds the audio.
        expect(after).toStrictEqual(before);

        for (const file of after) {
            expect((await readFile(file)).includes(MARKER.subarray(0, 64))).toBe(false);
        }

        expect((await stat(path.join(appData, "dictation", "models", spec.file))).size).toBe(WEIGHTS.length);
    });

    it("leaves no audio either when the helper dies", async () => {
        await writeFile(path.join(appData, "dictation", "models", spec.file), "die");

        const small: ModelSpec = { ...spec, bytes: 3, sha256: createHash("sha256").update("die").digest("hex") };
        const models = createModelStore({ directory: path.join(appData, "dictation", "models") });
        const recognizer = startRecognizer({
            cwd: path.join(appData, "dictation"),
            helper: { args: [FAKE], command: process.execPath },
            language: "auto",
            modelPath: await models.ensureVerified(small),
        });

        await expect(recognizer.transcribe(MARKER)).rejects.toMatchObject({ code: process.platform === "win32" ? "failed" : "crashed" });

        for (const file of [...await walk(temporary), ...await walk(appData)]) {
            expect((await readFile(file)).includes(MARKER.subarray(0, 64))).toBe(false);
        }
    });
});
