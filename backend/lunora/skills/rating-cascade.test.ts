/**
 * The rating cascade against an in-memory stand-in for the two `.global()`
 * tables it touches (the test harness cannot write D1 tables): deleting a
 * skill's ratings removes every rater's row and only that skill's, and
 * recomputing without a departing rater converges however often it runs —
 * before or after their rows are deleted.
 */
import { describe, expect, it } from "vitest";

import { deleteSkillRatings, recomputeSkillRatings } from "./rating-cascade";

interface Row {
    [field: string]: unknown;
    _id: string;
}

/** Whether `row` carries every field of `where` with that value. */
const matches = (row: Row, where: Record<string, unknown>): boolean => Object.entries(where).every(([key, value]) => row[key] === value);

const fakeDatabase = (tables: { skillRatings: Row[]; skillStats: Row[] }) => {
    const all = (): Row[] => [...tables.skillRatings, ...tables.skillStats];
    const findMany =
        (table: Row[]) =>
        async ({ where }: { where: Record<string, unknown> }) => {
            return { page: table.filter((row) => matches(row, where)) };
        };

    return {
        delete: async (id: string) => {
            tables.skillRatings = tables.skillRatings.filter((row) => row._id !== id);
            tables.skillStats = tables.skillStats.filter((row) => row._id !== id);
        },
        patch: async (id: string, fields: Record<string, unknown>) => {
            Object.assign(
                all().find((row) => row._id === id)!,
                fields,
            );
        },
        get skillRatings() {
            return { findMany: findMany(tables.skillRatings) };
        },
        get skillStats() {
            return { findMany: findMany(tables.skillStats) };
        },
    };
};

const seed = () => {
    return {
        skillRatings: [
            { _id: "r1", rating: 1, skillId: "skill-a", userId: "alice" },
            { _id: "r2", rating: 5, skillId: "skill-a", userId: "bob" },
            { _id: "r3", rating: 3, skillId: "skill-a", userId: "carol" },
            { _id: "r4", rating: 2, skillId: "skill-b", userId: "alice" },
            { _id: "r5", rating: 4, skillId: "skill-c", userId: "bob" },
        ],
        skillStats: [
            { _id: "s1", rating: 3, ratingCount: 3, skillId: "skill-a", usageCount: 7 },
            { _id: "s2", rating: 2, ratingCount: 1, skillId: "skill-b", usageCount: 0 },
            { _id: "s3", rating: 4, ratingCount: 1, skillId: "skill-c", usageCount: 0 },
        ],
    };
};

describe(deleteSkillRatings, () => {
    it("deletes every rater's rating of the skill and nothing else", async () => {
        const tables = seed();

        await expect(deleteSkillRatings(fakeDatabase(tables) as never, "skill-a" as never)).resolves.toBe(3);
        expect(tables.skillRatings.map((row) => row._id)).toStrictEqual(["r4", "r5"]);
        // Stats rows are the skill's own; the caller deletes them with the skill.
        expect(tables.skillStats).toHaveLength(3);
    });

    it("is idempotent", async () => {
        const tables = seed();
        const database = fakeDatabase(tables) as never;

        await deleteSkillRatings(database, "skill-a" as never);

        await expect(deleteSkillRatings(database, "skill-a" as never)).resolves.toBe(0);
        expect(tables.skillRatings).toHaveLength(2);
    });
});

describe(recomputeSkillRatings, () => {
    it("re-derives each listed skill's stats without the departing rater", async () => {
        const tables = seed();

        await recomputeSkillRatings(fakeDatabase(tables) as never, ["skill-a", "skill-b", "skill-a"] as never, "alice");

        expect(tables.skillStats).toStrictEqual([
            { _id: "s1", rating: 4, ratingCount: 2, skillId: "skill-a", usageCount: 7 },
            { _id: "s2", rating: 0, ratingCount: 0, skillId: "skill-b", usageCount: 0 },
            // Not listed, so untouched.
            { _id: "s3", rating: 4, ratingCount: 1, skillId: "skill-c", usageCount: 0 },
        ]);
    });

    it("converges whether it runs before or after the rater's rows are deleted, and on a retry", async () => {
        const tables = seed();
        const database = fakeDatabase(tables);

        await recomputeSkillRatings(database as never, ["skill-a"] as never, "alice");
        await database.delete("r1");
        await recomputeSkillRatings(database as never, ["skill-a"] as never, "alice");
        await recomputeSkillRatings(database as never, ["skill-a"] as never, "alice");

        expect(tables.skillStats[0]).toMatchObject({ rating: 4, ratingCount: 2 });
    });

    it("heals a drifted aggregate", async () => {
        const tables = seed();

        tables.skillStats[0]!.rating = 1.23;
        tables.skillStats[0]!.ratingCount = 99;

        await recomputeSkillRatings(fakeDatabase(tables) as never, ["skill-a"] as never, "nobody");

        expect(tables.skillStats[0]).toMatchObject({ rating: 3, ratingCount: 3 });
    });
});
