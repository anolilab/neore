/** `patchBetterAuthRow` converts a better-auth row's ISO dates in the same write, and never over a row that changed since it was read. */
import { afterEach, describe, expect, it } from "vitest";

import { harnessWithSqlite, storeDatesAsText } from "../../test/better-auth-dates";
import schema from "../schema";
import { patchBetterAuthRow } from "./better-auth-dates";

let current: ReturnType<typeof harnessWithSqlite> | undefined;

afterEach(() => {
    current?.harness.close();
});

describe("patchBetterAuthRow", () => {
    it("refuses with CONFLICT, writing nothing, when a date changed after the row was read", async () => {
        current = harnessWithSqlite(schema);

        const { harness, sqlite } = current;
        const id = await harness.run(async (ctx: any) =>
            ctx.db.insert("user", { createdAt: 1, email: "a@example.com", emailVerified: true, name: "A", updatedAt: 1 }),
        );

        storeDatesAsText(sqlite, "user", id, ["createdAt", "updatedAt"]);

        const { code, stored } = await harness.run(async (ctx: any) => {
            const read = await ctx.db.get("user", id);
            const stale = { ...read, updatedAt: "1970-01-01T00:00:00.000Z" };
            let refused: string | undefined;

            try {
                await patchBetterAuthRow(ctx.db, "user", stale, { role: "admin" });
            } catch (error) {
                refused = (error as { code?: string }).code;
            }

            return { code: refused, stored: await ctx.db.get("user", id) };
        });

        expect(code).toBe("CONFLICT");
        expect(stored).toMatchObject({ createdAt: "1970-01-01T00:00:00.001Z", updatedAt: "1970-01-01T00:00:00.001Z" });
        expect(stored.role).toBeUndefined();
    });
});
