import { execFileSync } from "node:child_process";
import type { Dirent } from "node:fs";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ElectronApplication, Page } from "@playwright/test";
import { _electron as electron, expect, test } from "@playwright/test";

import { wavBytes } from "../src/dictation/wav";

/** The probe the main process publishes when the dictation flag is on (`src/dictation/index.ts`). */
interface Probe {
    audioBytes: number;
    begin: () => void;
    cancel: () => void;
    end: () => void;
    helperPid: () => number | undefined;
    outcome: () => string | undefined;
    state: () => string;
    useTestEngine: (engine: { args: string[]; command: string; modelPath: string }) => void;
}

interface SiteBridge {
    takePendingDraft: () => Promise<string | undefined>;
}

const appDirectory = fileURLToPath(new URL("..", import.meta.url));
const FAKE_HELPER = path.join(appDirectory, "e2e", "fixtures", "fake-whisper-cli.mjs");
// The shell spec owns the base ports; this one runs beside it, never at the same time (one worker), on its own pair.
const SITE_PORT = Number(process.env.NEORE_E2E_PORT ?? 4399) + 20;
const SITE = `http://127.0.0.1:${SITE_PORT}`;
const FAKE_TRANSCRIPT = /^Hello from the fake recogniser, \d+ samples\. Second segment\.$/u;
const DICTATION_PAGE = /\/dictation-window\/dictation\.html$/u;
/** A real recogniser, when one is built: `NEORE_WHISPER_CLI` and `NEORE_WHISPER_MODEL`, and `NEORE_WHISPER_CLIP` (16 kHz mono WAV of speech). */
const REAL = { cli: process.env.NEORE_WHISPER_CLI, clip: process.env.NEORE_WHISPER_CLIP, model: process.env.NEORE_WHISPER_MODEL };

const USE_MICROPHONE = process.env.NEORE_E2E_MICROPHONE === "1";

let server: http.Server;
let scratch: string;
let tone: string;

/** Two seconds of a tone: what the fake microphone plays, and what the page sends, when no clip is given. */
const toneWav = (): Buffer => {
    const samples = Buffer.alloc(16_000 * 2 * 2);

    for (let index = 0; index < 32_000; index += 1) {
        samples.writeInt16LE(Math.round(Math.sin((index / 16_000) * 2 * Math.PI * 440) * 8000), index * 2);
    }

    return wavBytes(samples, 16_000);
};

test.beforeAll(async () => {
    server = http.createServer((_request, response) => {
        response.setHeader("content-type", "text/html");
        response.end("<!doctype html><title>site</title><body>site</body>");
    });
    await new Promise<void>((resolve) => {
        server.listen(SITE_PORT, "127.0.0.1", resolve);
    });
    execFileSync(process.execPath, ["scripts/build.mjs"], {
        cwd: appDirectory,
        env: { ...process.env, NEORE_DICTATION: "1", NEORE_SITE_URL: SITE },
        stdio: "inherit",
    });
    scratch = await mkdtemp(path.join(os.tmpdir(), "neore-dictation-e2e-"));
    tone = path.join(scratch, "tone.wav");
    await writeFile(tone, toneWav());
});

test.afterAll(async () => {
    server.close();
    await rm(scratch, { force: true, recursive: true });
});

interface Launched {
    app: ElectronApplication;
    temp: string;
    userData: string;
}

/** A fresh app with a fake microphone, its own user-data and temp folders (so a scan of them is clean), and a model file for the fake recogniser. */
const launch = async (clip = tone): Promise<Launched> => {
    const userData = await mkdtemp(path.join(scratch, "user-"));
    const temporary = await mkdtemp(path.join(scratch, "tmp-"));
    const app = await electron.launch({
        args: [
            ".",
            `--user-data-dir=${userData}`,
            "--use-fake-device-for-media-stream",
            "--use-fake-ui-for-media-stream",
            `--use-file-for-fake-audio-capture=${clip}`,
        ],
        cwd: appDirectory,
        env: { ...process.env, TEMP: temporary, TMP: temporary, TMPDIR: temporary },
    });

    return { app, temp: temporary, userData };
};

const useFakeRecogniser = async (app: ElectronApplication, behaviour = "recognise"): Promise<void> => {
    const modelPath = path.join(scratch, `model-${behaviour}.bin`);

    await writeFile(modelPath, behaviour);
    await app.evaluate((_electron, engine) => (globalThis as unknown as { neoreShell: { dictation: Probe } }).neoreShell.dictation.useTestEngine(engine), {
        args: [],
        command: FAKE_HELPER,
        modelPath,
    });
};

type ProbeMethod = "begin" | "cancel" | "end" | "helperPid" | "outcome" | "state";

/** Calls one of the probe's functions in the main process. */
const call = <Result = void>(app: ElectronApplication, method: ProbeMethod): Promise<Result> =>
    app.evaluate((_electron, name) => (globalThis as unknown as { neoreShell: { dictation: Record<string, () => unknown> } }).neoreShell.dictation[name]?.(), method) as Promise<Result>;

const audioBytes = (app: ElectronApplication): Promise<number> =>
    app.evaluate(() => (globalThis as unknown as { neoreShell: { dictation: Probe } }).neoreShell.dictation.audioBytes);

const findPage = async (app: ElectronApplication, isMatch: (url: string) => boolean): Promise<Page> => {
    await expect.poll(() => app.windows().filter((page) => isMatch(page.url())).length).toBeGreaterThan(0);

    return app.windows().find((page) => isMatch(page.url())) as Page;
};

const siteWindow = (app: ElectronApplication): Promise<Page> => findPage(app, (url) => url.startsWith(SITE));

/** The samples of a 16 kHz mono 16-bit WAV, without its header. */
const pcmOf = (wav: Buffer): Buffer => wav.subarray(wav.indexOf("data") + 8);

/**
 * Starts a dictation and gets `pcm` (two seconds of a tone by default) to the main process. The audio is sent through the capture
 * page's real preload bridge, the channel its microphone code uses, so the suite does not depend on an audio device; with
 * `NEORE_E2E_MICROPHONE=1` the page captures the (fake) microphone itself.
 */
const dictate = async (app: ElectronApplication, pcm: Buffer = pcmOf(toneWav())): Promise<void> => {
    await call(app, "begin");
    await expect.poll(() => call<string>(app, "state"), { timeout: 15_000 }).toBe("recording");

    if (!USE_MICROPHONE) {
        const page = await findPage(app, (url) => DICTATION_PAGE.test(url));

        await page.evaluate((encoded) => {
            const bridge = (globalThis as unknown as { neoreDictation: { audio: (chunk: ArrayBuffer) => void } }).neoreDictation;
            const bytes = Uint8Array.from(atob(encoded), (character) => character.codePointAt(0) ?? 0);

            // 1024 samples at a time, as the page's own capture sends them.
            for (let offset = 0; offset < bytes.length; offset += 2048) {
                bridge.audio(bytes.slice(offset, offset + 2048).buffer);
            }
        }, pcm.toString("base64"));
    }

    await expect.poll(() => audioBytes(app), { timeout: 15_000 }).toBeGreaterThan(48_000);
};

const walk = async (directory: string): Promise<string[]> => {
    const found: string[] = [];

    let entries: Dirent[] = [];

    try {
        entries = await readdir(directory, { withFileTypes: true });
    } catch {
        // Not created yet.
    }

    for (const entry of entries) {
        const full = path.join(directory, entry.name);

        if (entry.isDirectory()) {
            found.push(...await walk(full));
        } else if (entry.isFile()) {
            found.push(full);
        }
    }

    return found;
};

/** Files in `directories` that look like recorded audio: a RIFF/WAVE header anywhere in them. */
const audioFiles = async (directories: string[]): Promise<string[]> => {
    const found: string[] = [];

    const files = (await Promise.all(directories.map((directory) => walk(directory)))).flat();

    for (const file of files) {
        if ((await stat(file)).size >= 44 && (await readFile(file)).includes("WAVEfmt ")) {
            found.push(file);
        }
    }

    return found;
};

test("with the network blocked, a dictation completes and inserts its text as a draft", async () => {
    const { app, temp, userData } = await launch();

    try {
        const site = await siteWindow(app);

        await useFakeRecogniser(app);
        await dictate(app);

        // The capture window cannot reach anything: not the internet, not the loopback site, not a file outside its own folder.
        const page = await findPage(app, (url) => DICTATION_PAGE.test(url));
        const attempts = await page.evaluate(async (site_) => {
            const tryFetch = async (url: string) => {
                try {
                    await fetch(url);

                    return "reached";
                } catch {
                    return "blocked";
                }
            };

            return [await tryFetch("https://example.org/"), await tryFetch(site_), await tryFetch("file:///etc/hosts")];
        }, SITE);

        expect(attempts).toStrictEqual(["blocked", "blocked", "blocked"]);
        // Its bridge is the preload's four functions, nothing of the site's, and no Node.
        expect(new Set(await page.evaluate(() => Object.keys((globalThis as { neoreDictation?: object }).neoreDictation ?? {})))).toStrictEqual(new Set(["audio", "ended", "failed", "onStop"]));
        expect(await page.evaluate(() => [typeof (globalThis as { neoreNative?: unknown }).neoreNative, typeof (globalThis as { require?: unknown }).require])).toStrictEqual(["undefined", "undefined"]);

        await call(app, "end");
        await expect.poll(() => call<string | undefined>(app, "outcome")).toBe("inserted");

        const draft = await site.evaluate(() => (globalThis as { neoreNative?: SiteBridge }).neoreNative?.takePendingDraft());

        expect(draft).toMatch(FAKE_TRANSCRIPT);
        // The window closed on release, and nothing recorded stayed on disk.
        await expect.poll(() => app.windows().filter((window) => DICTATION_PAGE.test(window.url())).length).toBe(0);
        expect(await audioFiles([userData, temp])).toStrictEqual([]);
    } finally {
        await app.close();
    }
});

test("killing the helper shows an error and does not take the app down", async () => {
    const { app } = await launch();

    try {
        await siteWindow(app);
        await useFakeRecogniser(app);
        await dictate(app);

        const pid = await call<number | undefined>(app, "helperPid");

        expect(pid).toBeGreaterThan(0);
        process.kill(pid as number, "SIGKILL");

        await expect.poll(() => call<string | undefined>(app, "outcome")).toBe("error");
        expect(await call<string>(app, "state")).toBe("idle");
        await expect.poll(() => app.windows().filter((window) => DICTATION_PAGE.test(window.url())).length).toBe(0);

        // The app is alive and the next dictation works.
        await dictate(app);
        await call(app, "end");
        await expect.poll(() => call<string | undefined>(app, "outcome")).toBe("inserted");
    } finally {
        await app.close();
    }
});

test("a helper that dies while it holds the audio is also an error, not a crash", async () => {
    const { app } = await launch();

    try {
        await siteWindow(app);
        await useFakeRecogniser(app, "die");
        await dictate(app);
        await call(app, "end");

        await expect.poll(() => call<string | undefined>(app, "outcome")).toBe("error");
        expect(await call<string>(app, "state")).toBe("idle");
    } finally {
        await app.close();
    }
});

test("Escape cancels: nothing is recognised and the window closes", async () => {
    const { app } = await launch();

    try {
        await siteWindow(app);
        await useFakeRecogniser(app);
        await dictate(app);
        await call(app, "cancel");

        await expect.poll(() => call<string | undefined>(app, "outcome")).toBe("cancelled");
        await expect.poll(() => app.windows().filter((window) => DICTATION_PAGE.test(window.url())).length).toBe(0);
    } finally {
        await app.close();
    }
});

test("only the dictation window is given the microphone", async () => {
    const { app } = await launch();

    try {
        await siteWindow(app);
        await useFakeRecogniser(app);

        const microphone = (page: Page) =>
            page.evaluate(async () => {
                const status = await navigator.permissions.query({ name: "microphone" as PermissionName });

                return status.state;
            });
        // The Quick Composer is a local page of ours, and is refused.
        const composer = await findPage(app, (url) => url.endsWith("/quick-composer/index.html"));

        expect(await microphone(composer)).toBe("denied");

        await call(app, "begin");
        await expect.poll(() => call<string>(app, "state"), { timeout: 15_000 }).toBe("recording");
        expect(await microphone(await findPage(app, (url) => DICTATION_PAGE.test(url)))).toBe("granted");
        // And the window goes away with the dictation: the grant does not outlive it.
        await call(app, "cancel");
        await expect.poll(() => app.windows().filter((window) => DICTATION_PAGE.test(window.url())).length).toBe(0);
    } finally {
        await app.close();
    }
});

// Registered only when a real recogniser is given (NEORE_WHISPER_CLI, NEORE_WHISPER_MODEL and NEORE_WHISPER_CLIP): CI has no built whisper-cli, model or spoken clip.
if (REAL.cli !== undefined && REAL.model !== undefined && REAL.clip !== undefined) {
    test("recognises a spoken clip on the device", async () => {
        const { app } = await launch(REAL.clip);

        try {
            const site = await siteWindow(app);

            await app.evaluate((_electron, engine) => (globalThis as unknown as { neoreShell: { dictation: Probe } }).neoreShell.dictation.useTestEngine(engine), {
                args: [],
                command: REAL.cli as string,
                modelPath: REAL.model as string,
            });
            await dictate(app, pcmOf(await readFile(REAL.clip as string)));
            await call(app, "end");
            await expect.poll(() => call<string | undefined>(app, "outcome"), { timeout: 60_000 }).toBe("inserted");

            const draft = await site.evaluate(() => (globalThis as { neoreNative?: SiteBridge }).neoreNative?.takePendingDraft());

            expect(draft?.toLowerCase()).toContain("test");
        } finally {
            await app.close();
        }
    });
}
