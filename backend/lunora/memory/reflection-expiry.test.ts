/**
 * Nightly reflection retires a fact past its end date wherever it sits in the scope, and an expiry planned before a
 * restatement moved the end date leaves the fact in place.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi, registerModule } from "../../test/registered-api";
import schema from "../schema";
import { applyReflectionOps, runMemoryReflection } from "./reflection";
import { REFLECTION_LIMITS } from "./reflection-logic";

const { registry } = vi.hoisted(() => {
    return { registry: new Map<string, unknown>() };
});

vi.mock("../_generated/api", async (importOriginal) => registeredApi(await importOriginal(), registry));
vi.mock("../_generated/internal", async (importOriginal) => registeredApi(await importOriginal(), registry));
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
            throw new Error("no model in this test");
        },
    };
});
vi.mock("../lib/services", () => {
    return { gatewayFetch: () => async () => new Response("{}") };
});

const USER = "user-a";
const DAY = 24 * 60 * 60 * 1000;
// 03:00 UTC on 2026-09-26: inside the 02:00-06:00 night window.
const NIGHT = Date.UTC(2026, 8, 26, 3, 0);

let harness: ReturnType<typeof lunoraTest>;

const insert = async (memory: string, fields: Record<string, unknown> = {}): Promise<string> =>
    await harness.run(
        async (ctx: any) =>
            await ctx.db.insert("memories", {
                lastConfirmedAt: Date.now(),
                memory,
                source: "auto",
                type: "identity",
                updatedAt: Date.now(),
                userId: USER,
                ...fields,
            }),
    );

const supersededBy = async (id: string): Promise<unknown> => {
    const row = await harness.run(async (ctx: any) => await ctx.db.get("memories", id));

    return row.supersededBy;
};

beforeAll(async () => {
    registerModule(registry, "memory_reflection", await import("./reflection"));
    registerModule(registry, "bots_functions", await import("../bots/functions"));
});

beforeEach(async () => {
    vi.useFakeTimers({ now: NIGHT - 30 * DAY, toFake: ["Date"] });
    harness = lunoraTest(schema as never);

    await harness.run(async (ctx: any) => {
        await ctx.db.insert("userSettings", { memoryEnabled: true, timezone: "UTC", userId: USER });
        await ctx.db.insert("memoryReflectionState", { lastActiveAt: NIGHT - 60 * 60 * 1000, userId: USER });
    });
});

afterEach(() => {
    harness.close();
    vi.useRealTimers();
});

describe("reflection and expired facts", () => {
    it("retires an old expired fact that the recency selection leaves out", async () => {
        const expired = await insert("User is in Lisbon until 2026-09-20", { validUntil: "2026-09-20" });

        vi.setSystemTime(NIGHT - 60 * 60 * 1000);

        for (let i = 0; i < REFLECTION_LIMITS.maxMemories; i += 1) {
            await insert(`Fact ${i.toString(36)} q${i * 7919} z${i * 104_729}`);
        }

        vi.setSystemTime(NIGHT);
        await harness.action(async (ctx: any) => await ctx.runAction(runMemoryReflection, { userId: USER }));

        expect(await supersededBy(expired)).toBe(expired);
    });

    it("keeps a fact whose end date moved after the expiry was planned", async () => {
        const renewed = await insert("User is in Lisbon until 2026-09-30", { validUntil: "2026-09-30" });
        const ended = await insert("User is in Porto until 2026-09-20", { validUntil: "2026-09-20" });
        const ops = [renewed, ended].map((memoryId) => {
            return { byMemoryId: memoryId, expiredOn: "2026-09-26", kind: "supersede" as const, memoryId };
        });

        await harness.run(async (ctx: any) => await ctx.runMutation(applyReflectionOps, { ops, userId: USER }));

        expect(await supersededBy(renewed)).toBeUndefined();
        expect(await supersededBy(ended)).toBe(ended);
    });
});
