/**
 * The next-prompt suggestion after a reply: the setting, guests, locked and host-run threads gate the paid call, and a reply
 * is paid for once. The job calls `getAgent` (the model) only after every gate has passed, so "no call" is `getAgent` not
 * being called.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi, registerModule } from "../../test/registered-api";

import { admitFollowupSuggestions } from "../agent/followup-suggestions";
import schema from "../schema";
import { generateFollowupSuggestionsForThread } from "./functions";

const OWNER = "owner-user";

const registry = vi.hoisted(() => new Map<string, unknown>());
const getAgent = vi.hoisted(() => vi.fn());

vi.mock("../_generated/api", async (importOriginal) => registeredApi(await importOriginal(), registry));
vi.mock("../_generated/internal", async (importOriginal) => registeredApi(await importOriginal(), registry));
vi.mock("./lib/get-agent", () => {
    return { default: getAgent };
});

const REACHED = "getAgent reached";

beforeAll(async () => {
    registerModule(registry, "agent_threads", await import("../agent/threads"));
    registerModule(registry, "auth_functions", await import("../auth/functions"));
    registerModule(registry, "agent_followup_suggestions", await import("../agent/followup-suggestions"));
});

let harness: ReturnType<typeof lunoraTest>;
let threadId: string;

beforeEach(async () => {
    harness = lunoraTest(schema as never);
    getAgent.mockReset();
    getAgent.mockRejectedValue(new Error(REACHED));
    threadId = await harness.run(
        async (ctx: any) => await ctx.db.insert("threads", { createdAt: 1, status: "active", title: "T", updatedAt: 1, userId: OWNER }),
    );
});

afterEach(() => {
    harness.close();
});

const runJob = async (id = threadId) =>
    await harness.action(async (context: any) => await context.runAction(generateFollowupSuggestionsForThread, { threadId: id, userId: OWNER }));

describe("the setting", () => {
    it("off: the job picks no model and makes no call", async () => {
        await harness.run(async (ctx: any) => await ctx.db.insert("userSettings", { enableFollowupSuggestions: false, userId: OWNER }));

        await runJob();

        expect(getAgent).not.toHaveBeenCalled();
    });

    it("on, or never set: the job reaches the model", async () => {
        await runJob();

        expect(getAgent).toHaveBeenCalledTimes(1);
    });
});

describe("threads that never get a suggestion", () => {
    it("a locked thread gets no model call", async () => {
        const locked = await harness.run(
            async (ctx: any) => await ctx.db.insert("threads", { createdAt: 1, lockedAt: 1000, status: "active", title: "L", updatedAt: 1, userId: OWNER }),
        );

        await runJob(locked);

        expect(getAgent).not.toHaveBeenCalled();
    });

    it("a host-run thread gets no cloud model call", async () => {
        const host = await harness.run(
            async (ctx: any) => await ctx.db.insert("threads", { createdAt: 1, runner: "host", status: "active", title: "H", updatedAt: 1, userId: OWNER }),
        );

        await runJob(host);

        expect(getAgent).not.toHaveBeenCalled();
    });
});

describe("one paid call per reply", () => {
    const admit = async (lastMessageId: string, id = threadId) =>
        await harness.action(async (context: any) => await context.runMutation(admitFollowupSuggestions, { lastMessageId, threadId: id, userId: OWNER }));

    it("the first run of a reply is admitted, a second run of the same reply is not", async () => {
        await expect(admit("reply-1")).resolves.toBe(true);
        await expect(admit("reply-1")).resolves.toBe(false);
    });

    it("the next reply is admitted on its own claim", async () => {
        await admit("reply-1");

        await expect(admit("reply-2")).resolves.toBe(true);
    });

    it("a locked thread is not admitted", async () => {
        const locked = await harness.run(
            async (ctx: any) => await ctx.db.insert("threads", { createdAt: 1, lockedAt: 1000, status: "active", title: "L", updatedAt: 1, userId: OWNER }),
        );

        await expect(admit("reply-1", locked)).resolves.toBe(false);
    });
});
