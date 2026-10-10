/**
 * `createTitleChat` / `createCategoryChat` are scheduled at `/chat/start`. A
 * thread that is gone by the time they run (deleted, or a start that never
 * committed) is skipped: throwing only made the scheduler retry a job that can
 * never succeed.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi, registerModule } from "../../test/registered-api";

import schema from "../schema";
import { createCategoryChat, createTitleChat } from "./functions";

const registry = vi.hoisted(() => new Map<string, unknown>());

vi.mock("../_generated/api", async (importOriginal) => registeredApi(await importOriginal(), registry));
vi.mock("../_generated/internal", async (importOriginal) => registeredApi(await importOriginal(), registry));

// Reaching a model at all would be the bug: the thread is missing.
vi.mock("./lib/get-agent", () => {
    return {
        default: vi.fn(async () => {
            throw new Error("getAgent must not be reached for a missing thread");
        }),
    };
});

beforeAll(async () => {
    registerModule(registry, "agent_threads", await import("../agent/threads"));
});

let harness: ReturnType<typeof lunoraTest>;

beforeEach(() => {
    harness = lunoraTest(schema as never);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
    harness.close();
    vi.restoreAllMocks();
});

const MISSING = "00000000-0000-4000-8000-000000000000";

describe("title and category jobs for a missing thread", () => {
    it("createTitleChat returns quietly", async () => {
        await expect(
            harness.action(async (context: any) => await context.runAction(createTitleChat, { prompt: "hi", threadId: MISSING })),
        ).resolves.toBeUndefined();
    });

    it("createCategoryChat returns quietly", async () => {
        await expect(
            harness.action(async (context: any) => await context.runAction(createCategoryChat, { prompt: "hi", threadId: MISSING })),
        ).resolves.toBeUndefined();
    });
});
