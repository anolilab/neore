import type { Doc } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import type { StoredRow } from "../lib/stored-row";

type ProjectTable = QueryCtx["db"]["projects"];
type FindManyArgs = NonNullable<Parameters<ProjectTable["findMany"]>[0]>;

/**
 * What reading `rows` costs against the request's read budget: each whole stored row, as UTF-8 JSON. A metered
 * `.global()` read drops its `select`, charges the whole row and projects after, so naming fewer columns never lowers it.
 */
export const projectRowsReadBytes = (rows: ReadonlyArray<object>): number =>
    rows.reduce((total, row) => total + new TextEncoder().encode(JSON.stringify(row)).byteLength, 0);

/**
 * The projects `args` matches, whole, and what reading them cost ({@link projectRowsReadBytes}): for a read that budgets
 * its cost, the export's. It is charged the whole row whatever it selects, so it reads it to measure it; it must return
 * only the columns it picks from it.
 */
export const findProjectRowsMeasured = async (projects: ProjectTable, args: Omit<FindManyArgs, "select">) => {
    const result = await projects.findMany(args as FindManyArgs);
    const page = result.page as StoredRow<Doc<"projects">>[];

    return { ...result, page, readBytes: projectRowsReadBytes(page) };
};
