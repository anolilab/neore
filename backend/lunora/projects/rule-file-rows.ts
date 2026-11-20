/**
 * Where a project's rule files are stored: one `projectRuleFiles` row per project, holding the whole list in order. Off the
 * project row, which every project read is charged for whole (`backend/AGENTS.md`), so only the reads that need the
 * files pay for them: the editor, a run's setup and the export. Whoever passed the project's own check reads them, so
 * organization moves and sharing follow the project; the row's `userId` copies the project's owner only for erasure.
 */
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { LunoraError } from "lunorash/server";

import { isUniqueViolation } from "../lib/error-helpers";
import { projectRuleFiles, type RuleFile } from "./rule-files";

const primaryRead = { consistency: "primary" as const };

/** The `projectRuleFiles` row of `projectId`, or `null` before its first save. */
export const ruleFileRow = async (
    context: QueryCtx | MutationCtx,
    projectId: Id<"projects">,
    { primary = false } = {},
): Promise<Doc<"projectRuleFiles"> | null> => await context.db.projectRuleFiles.findFirst({ where: { projectId }, ...(primary && primaryRead) });

/** The rule files of `project` given its row ({@link ruleFileRow}), a legacy `context` first unless the row carries it. */
export const ruleFilesOf = (
    project: Pick<Doc<"projects">, "context">,
    row: Pick<Doc<"projectRuleFiles">, "carriedContext" | "files"> | null | undefined,
): RuleFile[] => projectRuleFiles({ carriedContext: row?.carriedContext, context: project.context, ruleFiles: row?.files });

/**
 * The rule files of a project the caller already passed its check for, a legacy `context` first (`projectRuleFiles`).
 * `primary` for a read a save compares against.
 */
export const readProjectRuleFiles = async (
    context: QueryCtx | MutationCtx,
    project: Pick<Doc<"projects">, "_id" | "context">,
    options: { primary?: boolean } = {},
): Promise<RuleFile[]> => ruleFilesOf(project, await ruleFileRow(context, project._id, options));

const stale = () => new LunoraError("CONFLICT", "The rule files were changed meanwhile. Reload them and save again.");

/**
 * Replaces the saved list of `project` with `files`, already normalized (`normalizeRuleFiles`), over `row`, the row the
 * save compared its revision against (`null` when it found none). One guarded step: the patch applies only while the
 * row still has the version read, and a first save's insert only while no row exists (the unique index), so of two
 * saves that checked the same revision the second is refused as stale (CONFLICT), never written over the first.
 */
export const writeProjectRuleFiles = async (
    context: MutationCtx,
    project: Pick<Doc<"projects">, "_id" | "userId">,
    row: Pick<Doc<"projectRuleFiles">, "_id" | "version"> | null,
    { carriedContext, files }: { carriedContext: string; files: RuleFile[] },
): Promise<void> => {
    if (row) {
        const { applied } = await context.db.patchIf("projectRuleFiles", row._id, {
            patch: { carriedContext, files, updatedAt: context.now, version: (row.version ?? 0) + 1, ...(project.userId && { userId: project.userId }) },
            where: { version: row.version ?? null },
        });

        if (!applied) {
            throw stale();
        }

        return;
    }

    try {
        await context.db.insert("projectRuleFiles", {
            carriedContext,
            deletingAt: 0,
            files,
            projectId: project._id,
            updatedAt: context.now,
            version: 1,
            ...(project.userId && { userId: project.userId }),
        });
    } catch (error) {
        if (isUniqueViolation(error)) {
            throw stale();
        }

        throw error;
    }
};
