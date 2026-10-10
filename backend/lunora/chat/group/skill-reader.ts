/**
 * The one place group chat reads `skills` rows. `skills` is a `.global()` (D1)
 * table, which the in-memory test harness cannot store — keeping the read
 * behind this seam lets `run.test.ts` serve skills from memory while every
 * other table goes through the real harness database.
 */
import type { Doc, Id } from "../../_generated/dataModel";
import type { QueryCtx as QueryContext } from "../../_generated/server";

/** The skills with these ids, `null` for a missing (or malformed) id, in input order. */
export const readSkills = async (context: Pick<QueryContext, "db">, skillIds: ReadonlyArray<string>): Promise<(Doc<"skills"> | null)[]> =>
    await Promise.all(skillIds.map(async (id) => await context.db.skills.findFirst({ where: { _id: id as Id<"skills"> } }).catch(() => null)));
