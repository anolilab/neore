/**
 * What the settings window can do, against a real model store and settings file in a temp folder and a `fetch` that is only counted.
 * These are the two acceptance checks of plans/desktop-dictation.md S3: with the switch off nothing is downloaded, and delete removes the file.
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ModelSpec, OfferedModel } from "./catalog.js";
import { createModelStore } from "./model-store.js";
import { createSettingsStore } from "./settings.js";
import type { SettingsApi } from "./settings-api.js";
import { createSettingsApi } from "./settings-api.js";

const WEIGHTS = Buffer.from("model weights stand-in");
const spec = (id: string, file: string): ModelSpec => {
    return { bytes: WEIGHTS.length, file, id, label: id, sha256: createHash("sha256").update(WEIGHTS).digest("hex"), url: `https://models.example/${file}`, version: "rev1" };
};
const SMALL = spec("small", "ggml-small.bin");
const LARGE = spec("large", "ggml-large.bin");
const OFFERED: OfferedModel[] = [
    { isDefault: true, note: "default", spec: SMALL },
    { isDefault: false, note: "slower", spec: LARGE },
];

let root: string;
let models: string;
let fetched: string[];
let log: string[];
let cancelled: number;
let helper: boolean;
let refused: boolean;
let beforeCancelDone: (() => Promise<void>) | undefined;
let shortcut: boolean[];
let api: SettingsApi;
let settingsFile: string;

beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "neore-dictation-api-"));
    models = path.join(root, "models");
    settingsFile = path.join(root, "settings.json");
    fetched = [];
    log = [];
    cancelled = 0;
    helper = true;
    refused = false;
    beforeCancelDone = undefined;
    shortcut = [];

    const settings = createSettingsStore(settingsFile, new Set(OFFERED.map((model) => model.spec.id)));
    const store = createModelStore({
        directory: models,
        fetch: async (url) => {
            fetched.push(String(url));

            return new Response(WEIGHTS);
        },
    });

    api = createSettingsApi({
        cancelDictation: async () => {
            cancelled += 1;
            await beforeCancelDone?.();
        },
        hasHelper: () => helper,
        models: store,
        offered: OFFERED,
        onEnabledChange: (enabled) => {
            shortcut.push(enabled);
        },
        onNotice: (message) => {
            log.push(message);
        },
        resolveModel: (current) => current.model ?? SMALL.id,
        settings,
        shortcut: "Ctrl Shift D",
        shortcutRefused: () => refused,
    });
});

afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { force: true, recursive: true });
});

const files = async (): Promise<string[]> => {
    try {
        return await readdir(models);
    } catch {
        return [];
    }
};

describe("with the switch off", () => {
    it("is off on a first run and shows both models as not downloaded", async () => {
        const view = await api.view();

        expect(view.enabled).toBe(false);
        expect(view.available).toBe(true);
        expect(view.models.map(({ id, state }) => [id, state])).toStrictEqual([["small", "missing"], ["large", "missing"]]);
        expect(fetched).toStrictEqual([]);
    });

    it("refuses a download: nothing is fetched and no file or folder appears", async () => {
        expect(() => api.download("small")).toThrow("turn dictation on");
        expect(() => api.download("large")).toThrow("turn dictation on");
        expect(fetched).toStrictEqual([]);
        expect(await files()).toStrictEqual([]);
        expect(log).toStrictEqual([]);
    });

    it("downloads after the switch is turned on, and stops again when it is turned off", async () => {
        await api.update({ enabled: true });
        await api.download("small").finished;

        expect(fetched).toStrictEqual([SMALL.url]);
        expect(await files()).toStrictEqual([SMALL.file]);
        expect((await api.view()).models[0]?.state).toBe("present");
        expect(log).toStrictEqual(["small is ready."]);

        await api.update({ enabled: false });

        expect(() => api.download("large")).toThrow("turn dictation on");
        expect(fetched).toHaveLength(1);
        expect(shortcut).toStrictEqual([true, false]);
    });

    it("stops a download that is running, and leaves no model and no partial file", async () => {
        const slow = createModelStore({
            directory: models,
            fetch: async (_url, init) => {
                // Like a real fetch: a signal that already fired refuses at once.
                (init?.signal as AbortSignal).throwIfAborted();

                return new Response(
                    new ReadableStream<Uint8Array>({
                        pull: async () =>
                            new Promise((_resolve, reject) => {
                                (init?.signal as AbortSignal).addEventListener("abort", () => reject((init?.signal as AbortSignal).reason));
                            }),
                    }),
                );
            },
        });
        const settings = createSettingsStore(settingsFile, new Set(["large", "small"]));
        const running = createSettingsApi({
            cancelDictation: async () => {},
            hasHelper: () => true,
            models: slow,
            offered: OFFERED,
            onEnabledChange: () => {},
            onNotice: (message) => {
                log.push(message);
            },
            resolveModel: () => SMALL.id,
            settings,
            shortcut: "x",
            shortcutRefused: () => false,
        });

        await running.update({ enabled: true });

        const { finished } = running.download("small");

        expect((await running.view()).models[0]?.state).toBe("downloading");
        await running.update({ enabled: false });
        await finished;

        expect(await files()).toStrictEqual([]);
        expect(log).toStrictEqual([]);
    });
});

describe("delete", () => {
    beforeEach(async () => {
        await api.update({ enabled: true });
        await api.download("small").finished;
        await api.download("large").finished;
    });

    it("removes that model's file from disk and leaves the other", async () => {
        expect(new Set(await files())).toStrictEqual(new Set([LARGE.file, SMALL.file]));

        await api.remove("small");

        expect(await files()).toStrictEqual([LARGE.file]);
        expect((await api.view()).models.map(({ state }) => state)).toStrictEqual(["missing", "present"]);
        expect(cancelled).toBe(1);
        expect(log.at(-1)).toBe("small was deleted from this computer.");
    });

    it("waits for the helper to let go before it deletes the file", async () => {
        let existedWhileCancelling = false;

        beforeCancelDone = async () => {
            existedWhileCancelling = (await files()).includes(SMALL.file);
        };
        await api.remove("small");

        expect(existedWhileCancelling).toBe(true);
        expect(await files()).toStrictEqual([LARGE.file]);
    });

    it("does not say it deleted a file it could not delete", async () => {
        // A directory where the file should be: the unlink fails with something other than "not found".
        await rm(path.join(models, SMALL.file));
        await mkdir(path.join(models, SMALL.file));

        await expect(api.remove("small")).rejects.toMatchObject({ code: "delete" });
        expect(log.filter((message) => message.includes("deleted"))).toStrictEqual([]);
        expect(await files()).toContain(SMALL.file);
    });

    it("works with the switch off too", async () => {
        await api.update({ enabled: false });
        await api.remove("large");

        expect(await files()).toStrictEqual([SMALL.file]);
    });
});

describe("where the speech helper was not built", () => {
    it("refuses to download and to turn the switch on, and leaves the stored switch off", async () => {
        helper = false;

        expect(() => api.download("small")).toThrow("not available");
        await expect(api.update({ enabled: true })).rejects.toThrow("not available");
        expect((await api.view()).enabled).toBe(false);
        expect((await api.view()).available).toBe(false);
        expect(fetched).toStrictEqual([]);
        expect(shortcut).toStrictEqual([]);
    });

    it("still lets the switch be turned off", async () => {
        await api.update({ enabled: true });
        helper = false;

        await expect(api.update({ enabled: false })).resolves.toMatchObject({ enabled: false });
    });
});

describe("the shortcut", () => {
    it("is reported unavailable only while the switch is on and the OS refused it", async () => {
        refused = true;

        expect((await api.view()).shortcutUnavailable).toBe(false);

        await api.update({ enabled: true });

        expect((await api.view()).shortcutUnavailable).toBe(true);

        refused = false;

        expect((await api.view()).shortcutUnavailable).toBe(false);
    });
});

describe("what the page may send", () => {
    it("refuses an unknown model for download, delete and choice", async () => {
        await api.update({ enabled: true });

        expect(() => api.download("../evil")).toThrow(TypeError);
        await expect(api.remove("../evil")).rejects.toThrow(TypeError);
        await expect(api.update({ model: "../evil" })).rejects.toThrow(TypeError);
        await expect(api.remove({ id: "small" })).rejects.toThrow(TypeError);
        expect(fetched).toStrictEqual([]);
    });

    it("refuses an update that is not exactly a switch, a model and a language, and stores none of it", async () => {
        await expect(api.update({ enabled: "yes" })).rejects.toThrow(TypeError);
        await expect(api.update({ enabled: true, shell: "rm -rf" })).rejects.toThrow(TypeError);
        await expect(api.update({ language: "-x" })).rejects.toThrow(TypeError);
        expect((await api.view()).enabled).toBe(false);
    });

    it("keeps the chosen model and language", async () => {
        await api.update({ language: "ja", model: "large" });

        const view = await api.view();

        expect(view).toMatchObject({ enabled: false, language: "ja", model: "large" });
        expect(view.languages.map(({ id }) => id)).toContain("zh");
    });
});
