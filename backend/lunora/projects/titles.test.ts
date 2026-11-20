/**
 * The title read of a view that only names projects, against the in-memory harness: it returns the titles and does not measure the
 * project documents, which only the export's budgeted title steps need.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import schema from "../schema";
import { readableProjectGrantsMeasured, readableProjectTitles } from "./functions";

const A = "user-a";

let harness: ReturnType<typeof lunoraTest>;

beforeEach(() => {
    harness = lunoraTest(schema as never);
});

afterEach(() => {
    harness.close();
});

describe(readableProjectTitles, () => {
    it("names a project by its title, and leaves its document unmeasured", async () => {
        const id = await harness.run(
            async (ctx: any) => await ctx.db.insert("projects", { createdAt: 1, description: "x".repeat(5000), title: "Mine", userId: A }),
        );

        const titles = await harness.run(async (ctx: any) => await readableProjectTitles(ctx, [id], A));

        expect([...titles]).toEqual([[id, "Mine"]]);
    });

    it("does not encode the project documents it reads for a title", async () => {
        const id = await harness.run(
            async (ctx: any) => await ctx.db.insert("projects", { createdAt: 1, description: "x".repeat(5000), title: "Mine", userId: A }),
        );
        const encode = vi.spyOn(TextEncoder.prototype, "encode");

        await harness.run(async (ctx: any) => await readableProjectTitles(ctx, [id], A));

        const measuredCalls = encode.mock.calls.filter(([text]) => typeof text === "string" && text.includes("description"));

        expect(measuredCalls).toHaveLength(0);
        encode.mockRestore();
    });

    it("still counts the bytes of the documents the budgeted read reads", async () => {
        const id = await harness.run(
            async (ctx: any) => await ctx.db.insert("projects", { createdAt: 1, description: "x".repeat(5000), title: "Mine", userId: A }),
        );

        const measured = await harness.run(async (ctx: any) => await readableProjectGrantsMeasured(ctx, [id], A));

        expect(measured.readBytes).toBeGreaterThan(5000);
    });
});
