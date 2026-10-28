import { execFileSync } from "node:child_process";
import type { Dirent } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ElectronApplication, Page } from "@playwright/test";
import { _electron as electron, expect, test } from "@playwright/test";

import { wavBytes } from "../src/dictation/wav";

/** The probe the main process publishes in an unpackaged build (`src/dictation/index.ts`). */
interface Probe {
    audioBytes: number;
    begin: () => void;
    cancel: () => void;
    end: () => void;
    helperPid: () => number | undefined;
    openSettings: () => void;
    outcome: () => string | undefined;
    state: () => string;
    useTestEngine: (engine: { args: string[]; command: string; modelPath: string }) => void;
}

interface SiteBridge {
    takePendingDraft: () => Promise<string | undefined>;
}

const appDirectory = fileURLToPath(new URL("..", import.meta.url));
const FAKE_HELPER = path.join(appDirectory, "e2e", "fixtures", "fake-whisper-cli.mjs");
/** Windows cannot run a script by its shebang, so the stand-in helper is a script given to the test runner's own node. */
const NODE = process.execPath;
// The shell spec owns the base ports; this one runs beside it, never at the same time (one worker), on its own pair.
const SITE_PORT = Number(process.env.NEORE_E2E_PORT ?? 4399) + 20;
const SITE = `http://127.0.0.1:${SITE_PORT}`;
const FAKE_TRANSCRIPT = /^Hello from the fake recogniser, \d+ samples\. Second segment\.$/u;
const DICTATION_PAGE = /\/dictation-window\/dictation\.html$/u;
/** A real recogniser, when one is built: `NEORE_WHISPER_CLI` and `NEORE_WHISPER_MODEL`, and `NEORE_WHISPER_CLIP` (16 kHz mono WAV of speech that says `NEORE_WHISPER_EXPECT`, "test" by default). */
const REAL = { cli: process.env.NEORE_WHISPER_CLI, clip: process.env.NEORE_WHISPER_CLIP, expect: process.env.NEORE_WHISPER_EXPECT ?? "test", model: process.env.NEORE_WHISPER_MODEL };
/** What CI says of this runner (`supported` or `unsupported`): an unsupported platform runs only the test that it says so. */
const EXPECTED_SUPPORT = process.env.NEORE_DICTATION_EXPECT;

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
        env: { ...process.env, NEORE_SITE_URL: SITE },
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

/**
 * A fresh app with a fake microphone, its own user-data and temp folders (so a scan of them is clean), and a model file for the fake recogniser.
 * Dictation is opt-in: the settings file in the new user-data folder turns it on, unless `enabled` is false (a first run).
 */
const launch = async (clip = tone, enabled = true): Promise<Launched> => {
    const userData = await mkdtemp(path.join(scratch, "user-"));

    if (enabled) {
        await mkdir(path.join(userData, "dictation"), { recursive: true });
        await writeFile(path.join(userData, "dictation", "settings.json"), JSON.stringify({ enabled: true }));
    }

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
        args: [FAKE_HELPER],
        command: NODE,
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
    // A dictation that ends before it records says why (its outcome), instead of only "idle".
    await expect
        .poll(
            async () => {
                const state = await call<string>(app, "state");

                if (state === "idle") {
                    throw new Error(`the dictation ended before it recorded: ${await call<string | undefined>(app, "outcome")}`);
                }

                return state;
            },
            { timeout: 15_000 },
        )
        .toBe("recording");

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

/** Distinctive samples appended to the audio the suite sends: if any file holds them, the recording was written to disk. Not sent when the page captures the microphone itself. */
const PCM_MARKER = Buffer.from("NEORE-AUDIO-MARKER-0123456789ABCDEF!!".repeat(64));

/** Files in `directories` that look like recorded audio: a RIFF/WAVE header, or the samples that were sent, anywhere in them. */
const audioFiles = async (directories: string[]): Promise<string[]> => {
    const found: string[] = [];

    const files = (await Promise.all(directories.map((directory) => walk(directory)))).flat();

    for (const file of files) {
        if ((await stat(file)).size < 44) {
            continue;
        }

        const content = await readFile(file);

        if (content.includes("WAVEfmt ") || content.includes(PCM_MARKER)) {
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
        const marked = Buffer.concat([pcmOf(toneWav()), PCM_MARKER]);

        await dictate(app, marked);

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
        // The page's CSP is only the first wall: the session itself cancels everything that is not the window's own assets.
        const fromSession = await app.evaluate(async ({ session }, urls) => {
            const results: string[] = [];

            for (const url of urls) {
                try {
                    await session.fromPartition("dictation").fetch(url);
                    results.push("reached");
                } catch (error) {
                    results.push(String(error));
                }
            }

            return results;
        }, ["https://example.org/", SITE]);

        // ERR_BLOCKED_BY_CLIENT is the request filter's own cancel, not an offline machine.
        expect(fromSession).toHaveLength(2);

        for (const result of fromSession) {
            expect(result).toContain("ERR_BLOCKED_BY_CLIENT");
        }

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

const SETTINGS_PAGE = /\/dictation-settings-window\/settings\.html$/u;
const DICTATION_KEY = /dictation|settings/iu;
const SHORTCUT = "CommandOrControl+Shift+D";

/** Whether the app holds the dictation shortcut with the OS right now. */
const shortcutHeld = (app: ElectronApplication): Promise<boolean> => app.evaluate(({ globalShortcut }, accelerator) => globalShortcut.isRegistered(accelerator), SHORTCUT);
const MODEL_FILES = ["ggml-small.bin", "ggml-large-v3-turbo-q5_0.bin"];

test("on a first run the switch is off: a press opens no window and downloads nothing", async () => {
    const { app, userData } = await launch(tone, false);

    try {
        await siteWindow(app);
        await call(app, "begin");

        await expect.poll(() => call<string | undefined>(app, "outcome")).toBe("disabled");
        expect(await call<string>(app, "state")).toBe("idle");
        expect(app.windows().filter((window) => DICTATION_PAGE.test(window.url()))).toHaveLength(0);
        expect(await walk(path.join(userData, "dictation", "models"))).toStrictEqual([]);
    } finally {
        await app.close();
    }
});

test("the settings window turns dictation on, deletes a model file, and is out of the site's reach", async () => {
    const { app, userData } = await launch(tone, false);

    try {
        const site = await siteWindow(app);
        const models = path.join(userData, "dictation", "models");

        await mkdir(models, { recursive: true });
        await Promise.all(MODEL_FILES.map((file) => writeFile(path.join(models, file), "weights")));

        // The site has no way to open it or to reach it: nothing about dictation settings on its bridge.
        const siteKeys = await site.evaluate(() => Object.keys((globalThis as { neoreNative?: object }).neoreNative ?? {}));

        expect(siteKeys.filter((key) => DICTATION_KEY.test(key))).toStrictEqual([]);

        // The page offers the switch only where the speech helper exists; the fake recogniser stands in for it.
        await useFakeRecogniser(app);
        await app.evaluate(() => (globalThis as unknown as { neoreShell: { dictation: Probe } }).neoreShell.dictation.openSettings());

        const page = await findPage(app, (url) => SETTINGS_PAGE.test(url));
        const switchControl = page.getByRole("switch", { name: "Dictate on this computer" });

        await expect(switchControl).not.toBeChecked();
        // Off, the app does not hold the key: other apps keep it.
        expect(await shortcutHeld(app)).toBe(false);
        expect(new Set(await page.evaluate(() => Object.keys((globalThis as { neoreDictationSettings?: object }).neoreDictationSettings ?? {})))).toStrictEqual(
            new Set(["download", "get", "onChanged", "remove", "update"]),
        );
        expect(await page.evaluate(() => [typeof (globalThis as { neoreNative?: unknown }).neoreNative, typeof (globalThis as { require?: unknown }).require])).toStrictEqual(["undefined", "undefined"]);

        await switchControl.check();
        await expect.poll(async () => JSON.parse(await readFile(path.join(userData, "dictation", "settings.json"), "utf8")).enabled).toBe(true);
        await expect.poll(() => shortcutHeld(app)).toBe(true);

        await page.getByLabel("Language").selectOption("de");
        await expect.poll(async () => JSON.parse(await readFile(path.join(userData, "dictation", "settings.json"), "utf8")).language).toBe("de");

        await page.getByRole("button", { name: "Delete Small from this computer" }).click();
        await expect.poll(() => readdir(models)).not.toContain("ggml-small.bin");
        expect(await readdir(models)).toStrictEqual(["ggml-large-v3-turbo-q5_0.bin"]);
        await expect(page.getByRole("status").filter({ hasText: "was deleted from this computer" })).toBeVisible();

        await switchControl.uncheck();
        await expect.poll(() => shortcutHeld(app)).toBe(false);

        // The window cannot reach the network either.
        const reached = await page.evaluate(async (site_) => {
            try {
                await fetch(site_);

                return "reached";
            } catch {
                return "blocked";
            }
        }, SITE);

        expect(reached).toBe("blocked");
    } finally {
        await app.close();
    }
});

// Registered only where CI expects the platform to be unsupported (`NEORE_DICTATION_EXPECT`): the other platforms must not be.
if (EXPECTED_SUPPORT === "unsupported") {
    test("an unsupported platform says so in settings and never holds the shortcut", async () => {
        // The switch is stored on, as if it had been turned on before: it must still do nothing here.
        const { app } = await launch();

        try {
            await siteWindow(app);
            await app.evaluate(() => (globalThis as unknown as { neoreShell: { dictation: Probe } }).neoreShell.dictation.openSettings());

            const page = await findPage(app, (url) => SETTINGS_PAGE.test(url));

            await expect(page.locator("#unavailable")).toBeVisible();
            await expect(page.locator("#unavailable")).toContainText("not available");
            await expect(page.getByRole("switch", { name: "Dictate on this computer" })).toBeDisabled();
            expect(await shortcutHeld(app)).toBe(false);

            await call(app, "begin");
            await expect.poll(() => call<string | undefined>(app, "outcome")).toBe("no-helper");
            expect(app.windows().filter((window) => DICTATION_PAGE.test(window.url()))).toHaveLength(0);
        } finally {
            await app.close();
        }
    });
}

// Registered only when a real recogniser is given (NEORE_WHISPER_CLI, NEORE_WHISPER_MODEL and NEORE_WHISPER_CLIP): `.github/workflows/dictation-desktop.yml` builds one, with a model and whisper.cpp's own spoken clip, on every supported OS.
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

            expect(draft?.toLowerCase()).toContain(REAL.expect);
        } finally {
            await app.close();
        }
    });
}
