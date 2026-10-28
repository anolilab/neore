import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createSettingsStore, DEFAULT_SETTINGS, LANGUAGES, parseSettings, parseUpdate } from "./settings.js";

const KNOWN = new Set(["large-v3-turbo-q5_0", "small"]);

describe("parseSettings", () => {
    it("is off, automatic and on the machine's default model when there is nothing stored", () => {
        expect(parseSettings(undefined, KNOWN)).toStrictEqual({ enabled: false, language: "auto", model: undefined });
        expect(DEFAULT_SETTINGS.enabled).toBe(false);
    });

    it.each(["", "not json", "null", "[]", "42", "\"true\""])("falls back to the defaults for %j", (raw) => {
        expect(parseSettings(raw, KNOWN)).toStrictEqual(DEFAULT_SETTINGS);
    });

    it.each([["true"], ["1"], ["\"yes\""], ["{}"], ["null"]])("keeps the switch off unless it is exactly true: enabled = %s", (value) => {
        expect(parseSettings(`{"enabled":${value}}`, KNOWN).enabled).toBe(value === "true");
    });

    it("keeps a valid choice and drops each invalid field on its own", () => {
        expect(parseSettings("{\"enabled\":true,\"language\":\"de\",\"model\":\"small\"}", KNOWN)).toStrictEqual({ enabled: true, language: "de", model: "small" });
        expect(parseSettings("{\"enabled\":true,\"language\":\"--evil\",\"model\":\"../x\"}", KNOWN)).toStrictEqual({ enabled: true, language: "auto", model: undefined });
    });
});

describe("parseUpdate", () => {
    it("accepts the three fields", () => {
        expect(parseUpdate({ enabled: true, language: "zh", model: "small" }, KNOWN)).toStrictEqual({ enabled: true, language: "zh", model: "small" });
    });

    it.each([
        ["not an object", "on"],
        ["an array", [true]],
        ["null", null],
        ["a string switch", { enabled: "true" }],
        ["an unknown language", { language: "xx" }],
        ["a language that is a flag", { language: "-h" }],
        ["an unknown model", { model: "huge" }],
        ["an unknown key", { enabled: true, extra: 1 }],
    ])("refuses %s", (_name, payload) => {
        expect(() => parseUpdate(payload, KNOWN)).toThrow(TypeError);
    });

    it("offers the nine benchmark languages and detection", () => {
        expect(new Set(LANGUAGES)).toStrictEqual(new Set(["auto", "de", "en", "es", "fr", "it", "ja", "pl", "pt", "zh"]));
    });
});

describe("the settings file", () => {
    let directory: string;
    let file: string;

    beforeEach(async () => {
        directory = await mkdtemp(path.join(os.tmpdir(), "neore-dictation-settings-"));
        file = path.join(directory, "dictation", "settings.json");
    });

    afterEach(async () => {
        await rm(directory, { force: true, recursive: true });
    });

    it("starts off when the file is missing and writes nothing until something changes", async () => {
        const store = createSettingsStore(file, KNOWN);

        expect(store.get()).toStrictEqual(DEFAULT_SETTINGS);
        await expect(readFile(file)).rejects.toThrow();
    });

    it("stores a change and reads it back in a new store, leaving no temp file", async () => {
        createSettingsStore(file, KNOWN).update({ enabled: true, language: "it" });

        expect(createSettingsStore(file, KNOWN).get()).toStrictEqual({ enabled: true, language: "it", model: undefined });
        expect(await readdir(path.dirname(file))).toStrictEqual(["settings.json"]);
    });

    it("reads a file somebody edited into nonsense as the defaults", async () => {
        await createSettingsStore(file, KNOWN).update({ enabled: true });
        await writeFile(file, "{\"enabled\":\"on\"");

        expect(createSettingsStore(file, KNOWN).get().enabled).toBe(false);
    });
});
