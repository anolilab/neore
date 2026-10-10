import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { GatewayModel } from "@neore/ai/models";
import { describe, expect, it, vi } from "vitest";

import { localizeModelDescription } from "@/lib/model-descriptions";

import { filterModelsByQuery, getModelSearchText } from "./utilities";

// The unit-test transform does not compile Lingui macros (vi.mock is hoisted).
vi.mock("@lingui/core/macro", () => {
    return {
        msg: (strings: TemplateStringsArray) => {
            return { id: strings.join("") };
        },
    };
});

/** The German catalog's single-line entries, English source → German. */
const GERMAN = new Map(
    [
        ...readFileSync(join(import.meta.dirname, "../../locales/de/messages.po"), "utf8")
            .replaceAll("\r\n", "\n")
            .matchAll(/^msgid "(.+)"\nmsgstr "(.+)"$/gm),
    ].map(([, english, german]) => [english, german]),
);

/** Stands in for `i18n._` with the German catalog active. */
const toGerman = (descriptor: { id?: string }) => GERMAN.get(descriptor.id ?? "") ?? descriptor.id ?? "";

const haiku = {
    desc: "Fastest, most affordable Claude model",
    displayProvider: "Anthropic",
    id: "anthropic/claude-haiku",
    name: "Claude Haiku",
} as GatewayModel;

const flux = {
    desc: "BFL's highest quality model via Replicate",
    displayProvider: "Black Forest Labs",
    id: "bfl/flux-pro",
    name: "FLUX Pro",
} as GatewayModel;

const items = [{ model: haiku }, { model: flux }];
const germanIndex = new Map(items.map(({ model }) => [model.id, getModelSearchText(model, localizeModelDescription(model.desc, toGerman))]));

const ids = (found: { model: GatewayModel }[]) => found.map(({ model }) => model.id);

describe(filterModelsByQuery, () => {
    it("matches the localized description", () => {
        expect(GERMAN.get("Fastest, most affordable Claude model")).toBe("Schnellstes und günstigstes Claude-Modell");
        expect(ids(filterModelsByQuery(items, "günstigstes", germanIndex))).toStrictEqual([haiku.id]);
        expect(ids(filterModelsByQuery(items, "  SCHNELLSTES ", germanIndex))).toStrictEqual([haiku.id]);
    });

    it("still matches the English description, the name, the id and the creator", () => {
        expect(ids(filterModelsByQuery(items, "affordable", germanIndex))).toStrictEqual([haiku.id]);
        expect(ids(filterModelsByQuery(items, "flux pro", germanIndex))).toStrictEqual([flux.id]);
        expect(ids(filterModelsByQuery(items, "bfl/", germanIndex))).toStrictEqual([flux.id]);
        expect(ids(filterModelsByQuery(items, "black forest", germanIndex))).toStrictEqual([flux.id]);
    });

    it("does not match across two fields", () => {
        // "…Haiku" (name) followed by "anthropic/…" (id) must not read as one string.
        expect(filterModelsByQuery(items, "haiku anthropic", germanIndex)).toStrictEqual([]);
    });

    it("returns every item for a blank query, and indexes a model the map lacks", () => {
        const emptyIndex = new Map<string, string>();

        expect(filterModelsByQuery(items, " ".repeat(3), germanIndex)).toBe(items);
        expect(ids(filterModelsByQuery(items, "replicate", emptyIndex))).toStrictEqual([flux.id]);
    });
});
