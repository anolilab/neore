/**
 * Saving imported memories: nothing without memory turned on, provenance on every
 * row, and a repeat of the same list — longer than extraction's 50-row dedup
 * window — adds nothing.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi, registerModule } from "../../test/registered-api";
import schema from "../schema";
import { importFacts, labelImportedText } from "./import";

const { embedMany, generateText, registry } = vi.hoisted(() => {
    return { embedMany: vi.fn(), generateText: vi.fn(), registry: new Map<string, unknown>() };
});

vi.mock("../_generated/api", async (importOriginal) => registeredApi(await importOriginal(), registry));
vi.mock("../_generated/internal", async (importOriginal) => registeredApi(await importOriginal(), registry));
vi.mock("ai", async (importOriginal) => {
    return { ...(await importOriginal<typeof import("ai")>()), generateText };
});
vi.mock("../chat/lib/model-filter-rules", () => {
    return {
        loadModelFilterRules: async () => {
            return {};
        },
    };
});
vi.mock("../lib/utility-model", () => {
    return {
        getUtilityModel: async () => {
            return {};
        },
        NO_ALLOWED_UTILITY_MODEL_MESSAGE: "no model",
        NoAllowedUtilityModelError: class extends Error {},
    };
});
// The harness action ctx has no `services`; dedup runs on text here.
vi.mock("../lib/services", () => {
    return { gatewayFetch: () => async () => new Response("{}") };
});
vi.mock("../agent/client/search", () => {
    return { embedMany };
});

const USER = "user-a";
const MEMORY_OFF_RE = /Turn on memory/;
// Distinct enough wording per row that text dedup never merges two of them.
const FACTS = Array.from({ length: 60 }, (_, index) => {
    return { memory: `The user owns collection item ${String(index)} named ${"xyz".repeat((index % 7) + 1)}${String(index * 31)}`, type: "context" as const };
});

let harness: ReturnType<typeof lunoraTest>;

const setMemoryEnabled = async (memoryEnabled: boolean) =>
    await harness.run(async (ctx: any) => {
        await ctx.db.insert("userSettings", { memoryEnabled, timezone: "UTC", userId: USER });
    });

const memories = async () => await harness.run(async (ctx: any) => await ctx.db.query("memories").collect());

const save = async (facts: ReadonlyArray<{ memory: string; type: "context" | "identity" }>) =>
    await harness.action(async (ctx: any) => await importFacts(ctx, { app: "gemini", facts, userId: USER }));

beforeAll(async () => {
    registerModule(registry, "memory_functions", await import("./functions"));
});

beforeEach(() => {
    harness = lunoraTest(schema as never);
    embedMany.mockRejectedValue(new Error("no embeddings in this test"));
});

afterEach(() => {
    harness.close();
    embedMany.mockReset();
    generateText.mockReset();
});

describe("importing another assistant's memory", () => {
    it("saves nothing and calls no model while memory is off", async () => {
        expect.assertions(3);

        await setMemoryEnabled(false);

        await expect(save(FACTS.slice(0, 3))).rejects.toThrow(MEMORY_OFF_RE);
        await expect(harness.action(async (ctx: any) => await labelImportedText(ctx, USER, "The user is a nurse in Hamburg"))).rejects.toThrow(MEMORY_OFF_RE);
        expect(await memories()).toHaveLength(0);
    });

    it("marks every saved row as imported from the chosen app", async () => {
        expect.assertions(2);

        await setMemoryEnabled(true);

        await save([{ memory: "The user is a nurse in Hamburg", type: "identity" }]);

        const rows = await memories();

        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ importedFrom: "gemini", memory: "The user is a nurse in Hamburg", source: "imported", type: "identity" });
    });

    it("revises a second fact against the text the first one merged into the same row", async () => {
        expect.assertions(2);

        await setMemoryEnabled(true);
        await harness.run(async (ctx: any) => {
            await ctx.db.insert("memories", { memory: "The user lives in Berlin near the river with a garden and bikes", type: "context", userId: USER });
        });
        generateText
            .mockResolvedValueOnce({ output: { action: "UPDATE", mergedMemory: "The user lives in Berlin near the river with a garden and bikes daily" } })
            .mockResolvedValueOnce({ output: { action: "IGNORE" } });

        await save([
            { memory: "The user lives in Berlin near the river with a garden and bikes daily", type: "context" },
            { memory: "The user lives in Berlin near the river with a garden and bikes daily often", type: "context" },
        ]);

        expect(generateText).toHaveBeenCalledTimes(2);
        expect(generateText.mock.calls[1]?.[0].prompt).toContain(
            "<existing_memory>The user lives in Berlin near the river with a garden and bikes daily</existing_memory>",
        );
    });

    it("adds nothing when the same long list is imported again", async () => {
        expect.assertions(3);

        await setMemoryEnabled(true);

        expect(await save(FACTS)).toStrictEqual({ added: 60, alreadyKnown: 0, updated: 0 });
        expect(await save(FACTS)).toStrictEqual({ added: 0, alreadyKnown: 60, updated: 0 });
        expect(await memories()).toHaveLength(60);
    });
});
