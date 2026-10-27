/**
 * Compression after extraction is its own scheduled job: the extraction action
 * does not start it as a call it never waits for, and a failure to schedule it
 * never fails the extraction.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi, registerModule } from "../../test/registered-api";
import schema from "../schema";
import { extractMemories } from "./extract";

const { embedMany, generateText, registry } = vi.hoisted(() => {
    return { embedMany: vi.fn(), generateText: vi.fn(), registry: new Map<string, unknown>() };
});

vi.mock("../_generated/api", async (importOriginal) => registeredApi(await importOriginal(), registry));
vi.mock("../_generated/internal", async (importOriginal) => registeredApi(await importOriginal(), registry));
vi.mock("ai", async (importOriginal) => {
    return { ...(await importOriginal<typeof import("ai")>()), generateText };
});
vi.mock("../lib/utility-model", () => {
    return {
        getUtilityModel: async () => {
            return {};
        },
    };
});
// The harness action ctx has no `services`; no embedding is wanted here either.
vi.mock("../lib/services", () => {
    return { gatewayFetch: () => async () => new Response("{}") };
});
vi.mock("../agent/client/search", () => {
    return { embedMany };
});

const USER = "user-a";
const MESSAGE = "My name is Dana and I work as a nurse in Hamburg, please remember that";

let harness: ReturnType<typeof lunoraTest>;
let threadId: string;

const extract = async () =>
    await harness.action(
        async (ctx: any) =>
            await ctx.runAction(extractMemories, {
                assistantResponse: "Nice to meet you, Dana.",
                threadId,
                userId: USER,
                userMessage: MESSAGE,
            }),
    );

beforeAll(async () => {
    registerModule(registry, "memory_functions", await import("./functions"));
    registerModule(registry, "lib_action_cache", await import("../lib/action-cache"));
});

beforeEach(async () => {
    harness = lunoraTest(schema as never);
    embedMany.mockRejectedValue(new Error("no embeddings in this test"));
    generateText.mockResolvedValue({ output: { facts: [{ confidence: 90, importance: 80, memory: "The user is a nurse in Hamburg", type: "identity" }] } });

    threadId = await harness.run(async (ctx: any) => {
        await ctx.db.insert("userSettings", { memoryEnabled: true, timezone: "UTC", userId: USER });

        return await ctx.db.insert("threads", { status: "regular", title: "Intro", updatedAt: Date.now(), userId: USER });
    });
});

afterEach(() => {
    harness.close();
    embedMany.mockReset();
    generateText.mockReset();
});

describe("compression after extraction", () => {
    it("is scheduled as its own job for the saved memories' thread", async () => {
        expect.assertions(3);

        await extract();

        const memories = await harness.run(async (ctx: any) => await ctx.db.query("memories").collect());
        const jobs = harness.scheduler.list().filter((job) => job.args.threadId === threadId);

        expect(memories).toHaveLength(1);
        expect(jobs).toHaveLength(1);
        expect(jobs[0]?.args).toMatchObject({ threadId, userId: USER });
    });

    it("schedules nothing when no memory was saved", async () => {
        expect.assertions(1);

        generateText.mockResolvedValue({ output: { facts: [] } });

        await extract();

        expect(harness.scheduler.list()).toHaveLength(0);
    });
});
