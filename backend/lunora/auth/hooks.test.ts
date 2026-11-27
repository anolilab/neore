/** `promoteVerifiedAdmin` grants the allowlisted address admin once it is verified, also on a row better-auth wrote. */
import { afterEach, describe, expect, it, vi } from "vitest";

import { harnessWithSqlite, storeDatesAsText } from "../../test/better-auth-dates";
import schema from "../schema";

vi.mock("../env", async (importOriginal) => {
    return { ...(await importOriginal<typeof import("../env")>()), ADMIN: "boss@example.com" };
});

const { promoteVerifiedAdmin } = await import("./hooks");

let current: ReturnType<typeof harnessWithSqlite> | undefined;

afterEach(() => {
    current?.harness.close();
});

describe("promoteVerifiedAdmin", () => {
    it("promotes a verified allowlisted user whose row holds better-auth's ISO dates", async () => {
        current = harnessWithSqlite(schema);

        const { harness, sqlite } = current;
        const user = await harness.run(async (ctx: any) =>
            ctx.db.insert("user", { createdAt: 1, email: "Boss@example.com", emailVerified: true, name: "Boss", updatedAt: 1 }),
        );

        storeDatesAsText(sqlite, "user", user, ["createdAt", "updatedAt"]);

        const stored = await harness.run(async (ctx: any) => {
            await ctx.runMutation(promoteVerifiedAdmin, { userId: user });

            return await ctx.db.get("user", user);
        });

        expect(stored).toMatchObject({ createdAt: 1, role: "admin", updatedAt: 1 });
    });
});
