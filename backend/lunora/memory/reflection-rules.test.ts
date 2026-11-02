/**
 * The nightly reflection reads the user's model filter rules before it claims the day: a read that fails leaves the
 * day unclaimed so the job can run again, instead of spending it on a run that ignored the user's filters.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi, registerModule } from "../../test/registered-api";
import schema from "../schema";
import { runMemoryReflection } from "./reflection";

const { loadModelFilterRules, registry } = vi.hoisted(() => {
    return { loadModelFilterRules: vi.fn(), registry: new Map<string, unknown>() };
});

vi.mock("../_generated/api", async (importOriginal) => registeredApi(await importOriginal(), registry));
vi.mock("../_generated/internal", async (importOriginal) => registeredApi(await importOriginal(), registry));
vi.mock("../chat/lib/model-filter-rules", () => {
    return { loadModelFilterRules };
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
const HOUR = 60 * 60 * 1000;
// 03:00 UTC: inside the 02:00-06:00 night window.
const NIGHT = Date.UTC(2026, 8, 26, 3, 0);

let harness: ReturnType<typeof lunoraTest>;

const state = async () => await harness.run(async (ctx: any) => await ctx.db.memoryReflectionState.findFirst({ where: { userId: USER } }));

const run = async () => await harness.action(async (ctx: any) => await ctx.runAction(runMemoryReflection, { userId: USER }));

beforeAll(async () => {
    registerModule(registry, "memory_reflection", await import("./reflection"));
    registerModule(registry, "bots_functions", await import("../bots/functions"));
});

beforeEach(async () => {
    vi.useFakeTimers({ now: NIGHT, toFake: ["Date"] });
    harness = lunoraTest(schema as never);

    await harness.run(async (ctx: any) => {
        await ctx.db.insert("userSettings", { memoryEnabled: true, timezone: "UTC", userId: USER });
        await ctx.db.insert("memoryReflectionState", { lastActiveAt: NIGHT - HOUR, userId: USER });
    });
});

afterEach(() => {
    harness.close();
    vi.useRealTimers();
    loadModelFilterRules.mockReset();
});

describe("runMemoryReflection and the model filter rules", () => {
    it("leaves the day unclaimed when the rules cannot be read, so a retry can run it", async () => {
        loadModelFilterRules.mockRejectedValueOnce(new Error("settings unavailable"));

        await expect(run()).rejects.toThrow("settings unavailable");
        expect(await state()).not.toHaveProperty("lastRunLocalDay", expect.anything());

        loadModelFilterRules.mockResolvedValue({});
        await run();

        expect(await state()).toHaveProperty("lastRunLocalDay", expect.any(String));
    });
});
