/**
 * The export's progress writes against the in-memory harness: a completed export is final, so a replayed write cannot move it back
 * to processing while its download is still due.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import schema from "../schema";
import { updateRequestProgress } from "./functions";

const A = "user-a";

let harness: ReturnType<typeof lunoraTest>;

beforeEach(() => {
    harness = lunoraTest(schema as never);
});

afterEach(() => {
    harness.close();
});

describe("updateRequestProgress", () => {
    it("does not move a completed export back, so a replay after a cleanup failure keeps its download", async () => {
        const requestId = await harness.run(
            async (ctx: any) =>
                await ctx.db.insert("gdprRequests", {
                    currentStep: "log-audit",
                    progress: 100,
                    requestedAt: 1,
                    requestType: "export",
                    status: "completed",
                    userEmail: "a@example.com",
                    userId: A,
                }),
        );

        // The handler's first write runs again on replay: it must not reopen the export.
        const applied = await harness.run(
            async (ctx: any) =>
                await ctx.runMutation(updateRequestProgress, { currentStep: "collecting_profile", progress: 10, requestId, status: "processing" }),
        );

        expect(applied).toBe(false);
        expect(await harness.run(async (ctx: any) => await ctx.db.get("gdprRequests", requestId))).toMatchObject({
            currentStep: "log-audit",
            progress: 100,
            status: "completed",
        });
    });

    it("still records the completed write of an export that is processing", async () => {
        const requestId = await harness.run(
            async (ctx: any) =>
                await ctx.db.insert("gdprRequests", {
                    progress: 90,
                    requestedAt: 1,
                    requestType: "export",
                    status: "processing",
                    userEmail: "a@example.com",
                    userId: A,
                }),
        );

        const applied = await harness.run(async (ctx: any) => await ctx.runMutation(updateRequestProgress, { progress: 100, requestId, status: "completed" }));

        expect(applied).toBe(true);
        expect(await harness.run(async (ctx: any) => await ctx.db.get("gdprRequests", requestId))).toMatchObject({ progress: 100, status: "completed" });
    });
});
