import { lunoraTest } from "@lunora/testing";
import { describe, expect, it } from "vitest";

import { schemaWithShardedTables } from "../../lib/test-schema";
import { isMergeDestination, isMergeSource } from "./merge-destination";

describe("isMergeDestination", () => {
    const insertUser = async (harness: ReturnType<typeof lunoraTest>, isAnonymous: boolean) =>
        (await harness.run(
            async (context: any) =>
                await context.db.insert("user", {
                    createdAt: 0,
                    email: `${String(Math.random())}@example.com`,
                    emailVerified: false,
                    isAnonymous,
                    name: "U",
                    updatedAt: 0,
                }),
        )) as string;

    it("is an account while its user row is there and is not a guest's, and stops being one once the row is gone", async () => {
        const harness = lunoraTest(schemaWithShardedTables(["user"]) as never);

        try {
            const account = await insertUser(harness, false);
            const guest = await insertUser(harness, true);
            const check = async (userId: string) => (await harness.run(async (context: any) => await isMergeDestination(context, userId))) as boolean;

            expect(await check(account)).toBe(true);
            expect(await check(guest)).toBe(false);

            await harness.run(async (context: any) => await context.db.delete("user", account));

            expect(await check(account)).toBe(false);
        } finally {
            harness.close();
        }
    });

    it("is a merge source while its user row is a guest's, and stops being one once the guest is deleted", async () => {
        const harness = lunoraTest(schemaWithShardedTables(["user"]) as never);

        try {
            const account = await insertUser(harness, false);
            const guest = await insertUser(harness, true);
            const check = async (userId: string) => (await harness.run(async (context: any) => await isMergeSource(context, userId))) as boolean;

            expect(await check(guest)).toBe(true);
            expect(await check(account)).toBe(false);

            await harness.run(async (context: any) => await context.db.delete("user", guest));

            expect(await check(guest)).toBe(false);
        } finally {
            harness.close();
        }
    });
});
