/**
 * `storedRow` narrows a `.global()` row's optional columns from codegen's `T | null` to `T`. That holds only while the
 * store never reads one back as `null`: an unset optional column has to come back absent from every read path.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import schema from "../schema";

let harness: ReturnType<typeof lunoraTest>;

beforeEach(() => {
    harness = lunoraTest(schema as never);
});

afterEach(() => {
    harness.close();
});

describe("an unset optional column of a .global() row", () => {
    const insertProject = async (): Promise<string> =>
        (await harness.run(async (ctx: any) => await ctx.db.insert("projects", { createdAt: 0, title: "p", userId: "user-1" }))) as string;

    it("is absent from findFirst, findMany, a select and a by-id read", async () => {
        const id = await insertProject();

        const rows = await harness.run(async (ctx: any) => {
            const { page } = await ctx.db.projects.findMany({ where: { userId: "user-1" } });

            return [
                await ctx.db.projects.findFirst({ where: { _id: id } }),
                page[0],
                await ctx.db.projects.findFirst({ select: ["title", "description"], where: { _id: id } }),
                await ctx.db.get("projects", id),
            ];
        });

        for (const row of rows as object[]) {
            expect(row).not.toHaveProperty("description");
            expect(row).not.toHaveProperty("color");
        }
    });

    it("is absent again after a replace drops it", async () => {
        const id = await insertProject();

        await harness.run(async (ctx: any) => await ctx.db.patch("projects", id, { description: "set" }));
        await harness.run(async (ctx: any) => await ctx.db.replace("projects", id, { createdAt: 0, title: "p", userId: "user-1" }));

        const row = await harness.run(async (ctx: any) => await ctx.db.projects.findFirst({ where: { _id: id } }));

        expect(row).not.toHaveProperty("description");
    });
});
