import type { Doc } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";

/**
 * A project row read without its rule files (`ruleFiles`, up to 1 MB a project): what every project read returns
 * ({@link findProjectRow}, {@link findProjectRows}). The rule-file editor, a run's setup and the export select the rule
 * files by name; only a writer that may replace the row (`patchRow` removing a column) reads it whole
 * (`project-reads.guard.test.ts`).
 */
export type ProjectRow = Omit<Doc<"projects">, "ruleFiles"> & { ruleFiles?: never };

// Every column but the rule files, checked against the schema by its type: a new column fails to compile until listed.
const columns: Record<Exclude<keyof Doc<"projects">, "_creationTime" | "_id" | "ruleFiles">, true> = {
    color: true,
    context: true,
    createdAt: true,
    defaultEnabledFeatures: true,
    defaultModel: true,
    defaultReasoningEffort: true,
    description: true,
    forkedFromId: true,
    galleryCategory: true,
    galleryFeatured: true,
    galleryForkCount: true,
    galleryPublishedAt: true,
    galleryTags: true,
    galleryViewCount: true,
    icon: true,
    isPublic: true,
    machineId: true,
    order: true,
    organizationId: true,
    path: true,
    pinnedAt: true,
    projectType: true,
    publicAccessToken: true,
    title: true,
    updatedAt: true,
    userId: true,
    workflowContent: true,
};

/** The `select` of a project read that leaves the rule files in the database: the row's other columns (`_id` and `_creationTime` always come). */
export const PROJECT_ROW_COLUMNS = Object.keys(columns) as (keyof typeof columns)[];

type ProjectTable = QueryCtx["db"]["projects"];
type FindFirstArgs = NonNullable<Parameters<ProjectTable["findFirst"]>[0]>;
type FindManyArgs = NonNullable<Parameters<ProjectTable["findMany"]>[0]>;

/** The first project `args` matches, without its rule files. */
export const findProjectRow = async (projects: ProjectTable, args: Omit<FindFirstArgs, "select">): Promise<ProjectRow | null> =>
    // The typed `select` result is a union of one-column picks; the columns read are all but `ruleFiles`.
    (await projects.findFirst({ ...args, select: PROJECT_ROW_COLUMNS } as FindFirstArgs)) as unknown as ProjectRow | null;

/** The projects `args` matches, without their rule files. */
export const findProjectRows = async (projects: ProjectTable, args: Omit<FindManyArgs, "select">) => {
    const result = await projects.findMany({ ...args, select: PROJECT_ROW_COLUMNS } as FindManyArgs);

    return { ...result, page: result.page as unknown as ProjectRow[] };
};
