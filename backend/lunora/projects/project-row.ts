import type { Doc } from "../_generated/dataModel";

/**
 * A project row read without its rule files (`ruleFiles`, up to 1 MB a project): what project lists and single-project
 * reads return. Only the rule-file editor, a run's setup, the export and the writing mutation read the whole row.
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
