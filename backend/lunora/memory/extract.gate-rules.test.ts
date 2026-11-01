/**
 * The gate's classifier fails OPEN, and reading the user's model filter rules is part of that call: an unreadable
 * read must not crash the extraction (no gate log, exchange never marked processed), it extracts anyway and the
 * extraction itself then skips for lack of an allowed model.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi, registerModule } from "../../test/registered-api";
import schema from "../schema";
import { extractMemories } from "./extract";

const { generateText, loadModelFilterRules, registry } = vi.hoisted(() => {
    return { generateText: vi.fn(), loadModelFilterRules: vi.fn(), registry: new Map<string, unknown>() };
});

vi.mock("../_generated/api", async (importOriginal) => registeredApi(await importOriginal(), registry));
vi.mock("../_generated/internal", async (importOriginal) => registeredApi(await importOriginal(), registry));
vi.mock("ai", async (importOriginal) => {
    return { ...(await importOriginal<typeof import("ai")>()), generateText };
});
vi.mock("../chat/lib/model-filter-rules", () => {
    return { loadModelFilterRules };
});
vi.mock("../lib/utility-model", () => {
    class NoAllowedUtilityModelError extends Error {}

    return {
        getUtilityModel: async () => {
            return {};
        },
        NoAllowedUtilityModelError,
    };
});
vi.mock("../lib/services", () => {
    return { gatewayFetch: () => async () => new Response("{}") };
});

const USER = "user-a";
// First person, but no explicit disclosure pattern: the heuristic is unsure and asks the classifier.
const MESSAGE = "I wonder whether we could restructure the importer a little differently this time around";

let harness: ReturnType<typeof lunoraTest>;
let threadId: string;

beforeAll(async () => {
    registerModule(registry, "memory_functions", await import("./functions"));
    registerModule(registry, "lib_action_cache", await import("../lib/action-cache"));
});

beforeEach(async () => {
    harness = lunoraTest(schema as never);
    threadId = await harness.run(async (ctx: any) => {
        await ctx.db.insert("userSettings", { memoryEnabled: true, timezone: "UTC", userId: USER });

        return await ctx.db.insert("threads", { status: "regular", title: "Intro", updatedAt: Date.now(), userId: USER });
    });
});

afterEach(() => {
    harness.close();
    generateText.mockReset();
    loadModelFilterRules.mockReset();
});

describe("extractMemories when the model filter rules cannot be read", () => {
    it("does not crash: the classifier fails open and the extraction skips quietly", async () => {
        const { NoAllowedUtilityModelError } = await import("../lib/utility-model");

        loadModelFilterRules.mockRejectedValue(new NoAllowedUtilityModelError());

        await expect(
            harness.action(
                async (ctx: any) =>
                    await ctx.runAction(extractMemories, { assistantResponse: "Sure, here is one way.", threadId, userId: USER, userMessage: MESSAGE }),
            ),
        ).resolves.toBeUndefined();

        expect(loadModelFilterRules).toHaveBeenCalled();
        expect(generateText).not.toHaveBeenCalled();
    });
});
