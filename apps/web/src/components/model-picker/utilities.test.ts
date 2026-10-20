import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { GatewayModel } from "@neore/ai/models";
import { describe, expect, it, vi } from "vitest";

import { localizeModelDescription } from "@/lib/model-descriptions";

import {
    adjacentFavorite,
    filterModelsByBlockedCreators,
    filterModelsByQuery,
    formatPricePerMillion,
    getCreatorSlug,
    getModelLabel,
    getModelSearchText,
    moveFavorite,
    sortModels,
} from "./utilities";

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

describe(filterModelsByBlockedCreators, () => {
    const llama = { displayProvider: "Meta", id: "meta-llama/llama-3", provider: "openrouter" } as GatewayModel;
    const llamaElsewhere = { displayProvider: "Meta", id: "meta-llama/other", provider: "groq" } as GatewayModel;
    const gpt = { displayProvider: "OpenAI", id: "openai/gpt-4o", provider: "openai" } as GatewayModel;
    const all = [llama, llamaElsewhere, gpt];

    it("hides every model of a blocked lab, whichever route serves it", () => {
        expect(filterModelsByBlockedCreators(all, [getCreatorSlug(llama)])).toStrictEqual([gpt]);
    });

    it("returns the same list when nothing is blocked", () => {
        expect(filterModelsByBlockedCreators(all, [])).toBe(all);
    });
});

describe(getModelLabel, () => {
    const model = { id: "anthropic/claude-haiku", name: "Anthropic: Claude Haiku" } as GatewayModel;

    it("prefers the user's nickname", () => {
        expect(getModelLabel(model, { [model.id]: "Quick one" })).toBe("Quick one");
    });

    it("falls back to the catalog name without its provider prefix, then to the id", () => {
        expect(getModelLabel(model)).toBe("Claude Haiku");
        expect(getModelLabel(model, { "other/model": "x" })).toBe("Claude Haiku");
        expect(getModelLabel({ id: "a/b" } as GatewayModel)).toBe("a/b");
    });

    it("lets a nickname be found by search", () => {
        const index = new Map([[model.id, getModelSearchText(model, undefined, "Quick one")]]);

        expect(ids(filterModelsByQuery([{ model }], "quick", index))).toStrictEqual([model.id]);
    });
});

describe(sortModels, () => {
    const priced = (id: string, input: number | undefined, extra: Partial<GatewayModel> = {}) =>
        ({ id, name: id, pricing: input === undefined ? undefined : { input_per_million: input, output_per_million: input * 4 }, ...extra }) as GatewayModel;
    const cheap = priced("cheap", 0.1);
    const mid = priced("mid", 3);
    const dear = priced("dear", 15);
    const unpriced = priced("unpriced", undefined);
    const list = [mid, unpriced, dear, cheap];
    const order = (models: GatewayModel[]) => models.map((model) => model.id);

    it("keeps the catalog order for the default sort", () => {
        expect(sortModels(list, "default")).toBe(list);
    });

    it("sorts by price, with unpriced models last in both directions", () => {
        expect(order(sortModels(list, "price-asc"))).toStrictEqual(["cheap", "mid", "dear", "unpriced"]);
        expect(order(sortModels(list, "price-desc"))).toStrictEqual(["dear", "mid", "cheap", "unpriced"]);
    });

    it("sorts by the displayed name, nickname included", () => {
        expect(order(sortModels(list, "name"))).toStrictEqual(["cheap", "dear", "mid", "unpriced"]);
        expect(order(sortModels(list, "name", { dear: "Alpha" }))).toStrictEqual(["dear", "cheap", "mid", "unpriced"]);
    });

    it("puts new models first and keeps the catalog order otherwise", () => {
        const fresh = priced("fresh", 1, { isNew: true });

        expect(order(sortModels([mid, fresh, dear], "new"))).toStrictEqual(["fresh", "mid", "dear"]);
    });

    it("does not mutate its input", () => {
        const before = order(list);

        sortModels(list, "price-asc");

        expect(order(list)).toStrictEqual(before);
    });
});

describe(formatPricePerMillion, () => {
    it.each([
        [3, "$3.00"],
        [0.075, "$0.075"],
        [0.15, "$0.15"],
        [1.5, "$1.50"],
    ])("formats %d as %s", (value, expected) => {
        expect(formatPricePerMillion(value)).toBe(expected);
    });
});

describe(moveFavorite, () => {
    it("moves one favorite to where another sits", () => {
        expect(moveFavorite(["a", "b", "c", "d"], "d", "b")).toStrictEqual(["a", "d", "b", "c"]);
        expect(moveFavorite(["a", "b", "c", "d"], "a", "c")).toStrictEqual(["b", "c", "a", "d"]);
    });

    it("keeps favorites the screen does not show", () => {
        // "gone" is hidden or no longer in the catalog: the visible list is a, b, c.
        expect(moveFavorite(["a", "gone", "b", "c"], "c", "a")).toStrictEqual(["c", "a", "gone", "b"]);
    });

    it("changes nothing for an unknown id or a move onto itself", () => {
        const favorites = ["a", "b"];

        expect(moveFavorite(favorites, "x", "a")).toStrictEqual(favorites);
        expect(moveFavorite(favorites, "a", "x")).toStrictEqual(favorites);
        expect(moveFavorite(favorites, "a", "a")).toStrictEqual(favorites);
    });
});

describe(adjacentFavorite, () => {
    it("returns the neighbour on the screen, and nothing past either end", () => {
        const visible = ["a", "b", "c"];

        expect(adjacentFavorite(visible, "b", -1)).toBe("a");
        expect(adjacentFavorite(visible, "b", 1)).toBe("c");
        expect(adjacentFavorite(visible, "a", -1)).toBeUndefined();
        expect(adjacentFavorite(visible, "c", 1)).toBeUndefined();
        expect(adjacentFavorite(visible, "x", 1)).toBeUndefined();
    });
});
