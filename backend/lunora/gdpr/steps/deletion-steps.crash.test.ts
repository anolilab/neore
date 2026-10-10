/**
 * Account deletion must converge under a crash storm: a step that dies part-way
 * and is retried by the workflow has to finish the job, not strand rows.
 *
 * The facade below commits every delete on its own and rolls nothing back — the
 * semantics of the `.global()` D1 tables, and the worst case for the sharded ones
 * (whose DO transaction would in fact undo a failed mutation). A step that is
 * safe here is safe on either backend.
 *
 * The regression this pins: `deleteUserSkills` deleted `skills` in the same
 * parallel batch as `skillStats` / `skillFiles`. A failed child delete left the
 * parent gone, and those two tables carry no `userId`, so the retry could not
 * reach them — two D1 rows per skill survived the erasure.
 */
import { describe, expect, it } from "vitest";

import { deleteUserSkills } from "./deletion-steps";

const A = "user-a";
const B = "user-b";

interface Entry {
    row: Record<string, unknown>;
    table: string;
}

/** Decides whether the Nth delete call (0-based) against `table` fails. */
type FailWhen = (call: number, table: string) => boolean;

const fakeDb = (tables: Record<string, Record<string, unknown>[]>) => {
    let nextId = 0;
    let deleteCalls = 0;
    let failWhen: FailWhen = (_call, _table) => false;
    const rows = new Map<string, Entry>();

    for (const [table, list] of Object.entries(tables)) {
        for (const row of list) {
            nextId += 1;

            const id = typeof row._id === "string" ? row._id : `${table}-${String(nextId)}`;

            rows.set(id, { row: { ...row, _id: id }, table });
        }
    }

    const matching = (table: string, where: Record<string, unknown>) =>
        [...rows.values()]
            .filter((entry) => entry.table === table && Object.keys(where).every((key) => entry.row[key] === where[key]))
            .map((entry) => entry.row);

    const db = new Proxy(
        {
            delete: async (id: string) => {
                const call = deleteCalls;
                const table = rows.get(id)?.table ?? "?";

                deleteCalls += 1;
                // Let the other in-flight deletes of the batch run first, as they do on D1.
                await Promise.resolve();

                if (failWhen(call, table)) {
                    throw new Error(`Network connection lost (delete ${id})`);
                }

                rows.delete(id);
            },
            query: (table: string) => {
                const where: Record<string, unknown> = {};
                const builder = {
                    collect: async () => matching(table, where),
                    withIndex: (_name: string, range: (q: { eq: (field: string, value: unknown) => unknown }) => unknown) => {
                        const q = {
                            eq: (field: string, value: unknown) => {
                                where[field] = value;

                                return q;
                            },
                        };

                        range(q);

                        return builder;
                    },
                };

                return builder;
            },
        } as Record<string, unknown>,
        {
            get: (target, key: string) =>
                target[key] ?? {
                    findMany: async ({ where = {} }: { where?: Record<string, unknown> }) => {
                        return { page: matching(key, where) };
                    },
                },
        },
    );

    return {
        context: { db, scheduler: { runAfter: async () => undefined } },
        count: (table: string) => [...rows.values()].filter((entry) => entry.table === table).length,
        deleteCalls: () => deleteCalls,
        failing: (when: FailWhen) => {
            deleteCalls = 0;
            failWhen = when;
        },
        ratingsOf: (skillId: string) => [...rows.values()].filter((entry) => entry.table === "skillRatings" && entry.row.skillId === skillId).length,
    };
};

const run = async (step: unknown, context: object, args: Record<string, string>): Promise<void> => {
    const { handler } = step as { handler: (context: object, args: object) => Promise<unknown> };

    await handler(context, args);
};

/** Two skills per user, each with history, stats and files. */
const skillFixture = () => {
    const tables: Record<string, Record<string, unknown>[]> = {
        skillFiles: [],
        skillHistory: [],
        skillInvocations: [],
        skillRatings: [],
        skills: [],
        skillStats: [],
        userSkills: [],
    };

    for (const userId of [A, B]) {
        for (const index of [0, 1]) {
            const skillId = `${userId}-skill-${String(index)}`;

            tables.skills!.push({ _id: skillId, userId });
            tables.skillStats!.push({ skillId, usageCount: 1 });
            tables.skillFiles!.push({ skillId, storageId: `blob-${skillId}` });
            tables.skillHistory!.push({ skillId, userId });
            tables.userSkills!.push({ skillId, userId });
            tables.skillInvocations!.push({ skillId, userId });
            // Rated by the OTHER user — a row the owner's erasure can reach only through `skillId`.
            tables.skillRatings!.push({ rating: 4, skillId, userId: userId === A ? B : A });
        }
    }

    return tables;
};

const SKILL_TABLES = ["skills", "skillStats", "skillFiles", "skillHistory", "userSkills", "skillInvocations", "skillRatings"];

/** B's two skills and every per-skill child survive. */
const B_ROWS_PER_TABLE = 2;

describe("deleteUserSkills under a crash storm", () => {
    it("leaves no stats or files behind when their deletes fail and the step is retried", async () => {
        const fake = fakeDb(skillFixture());

        fake.failing((_call, table) => table === "skillStats" || table === "skillFiles");
        await expect(run(deleteUserSkills, fake.context, { userId: A })).rejects.toThrow("Network connection lost");

        fake.failing(() => false);
        await run(deleteUserSkills, fake.context, { userId: A });

        for (const table of SKILL_TABLES) {
            expect({ count: fake.count(table), table }).toStrictEqual({ count: B_ROWS_PER_TABLE, table });
        }
    });

    it("converges from a crash at every delete, with no residual row for the deleted user", async () => {
        const probe = fakeDb(skillFixture());

        await run(deleteUserSkills, probe.context, { userId: A });

        const totalDeletes = probe.deleteCalls();

        expect(totalDeletes).toBeGreaterThan(0);

        for (let crashAt = 0; crashAt < totalDeletes; crashAt += 1) {
            const fake = fakeDb(skillFixture());

            // The isolate dies at delete `crashAt`: that call and everything after it fails.
            fake.failing((call) => call >= crashAt);
            await expect(run(deleteUserSkills, fake.context, { userId: A })).rejects.toThrow();

            fake.failing(() => false);
            await run(deleteUserSkills, fake.context, { userId: A });

            for (const table of SKILL_TABLES) {
                expect({ count: fake.count(table), crashAt, table }).toStrictEqual({ count: B_ROWS_PER_TABLE, crashAt, table });
            }
        }
    });
});

describe("deleteUserSkills and other users' ratings", () => {
    it("removes ratings written by OTHER users together with the deleted user's skills", async () => {
        const fake = fakeDb(skillFixture());

        await run(deleteUserSkills, fake.context, { userId: A });

        expect(fake.ratingsOf(`${A}-skill-0`)).toBe(0);
        expect(fake.ratingsOf(`${A}-skill-1`)).toBe(0);
        // B's skills keep the ratings A wrote; those go with A's identity, not A's skills.
        expect(fake.ratingsOf(`${B}-skill-0`)).toBe(1);
    });
});

