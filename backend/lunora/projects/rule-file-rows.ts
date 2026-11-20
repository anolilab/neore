/**
 * Where a project's rule files are stored: one `projectRuleFiles` row per project, holding the whole list in order. Off the
 * project row, which every project read is charged for whole (`backend/AGENTS.md`), so only the reads that need the
 * files pay for them: the editor, a run's setup and the export. No owner column: whoever passed the project's own check
 * reads them, so organization moves, sharing and account merges follow the project with nothing to re-stamp.
 */
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { LunoraError } from "lunorash/server";

import { isUniqueViolation } from "../lib/error-helpers";
import { projectRuleFiles, type RuleFile } from "./rule-files";

const primaryRead = { consistency: "primary" as const };

/** The `projectRuleFiles` row of `projectId`, or `null` before its first save. */
const ruleFileRow = async (context: QueryCtx | MutationCtx, projectId: Id<"projects">, { primary = false } = {}) =>
    await context.db.projectRuleFiles.findFirst({ where: { projectId }, ...(primary && primaryRead) });

/**
 * The rule files of a project the caller already passed its check for, a legacy `context` first (`projectRuleFiles`).
 * `primary` for a read a save compares against.
 */
export const readProjectRuleFiles = async (
    context: QueryCtx | MutationCtx,
    project: Pick<Doc<"projects">, "_id" | "context">,
    options: { primary?: boolean } = {},
): Promise<RuleFile[]> => {
    const saved = await ruleFileRow(context, project._id, options);

    return projectRuleFiles({ context: project.context, ruleFiles: saved?.files });
};

/**
 * Replaces the saved list of `projectId` with `files`, already normalized (`normalizeRuleFiles`). Two first saves at
 * once both find no row: the second insert breaks the unique index and is refused as the stale save it is (CONFLICT).
 */
export const writeProjectRuleFiles = async (context: MutationCtx, projectId: Id<"projects">, files: RuleFile[]): Promise<void> => {
    const row = await ruleFileRow(context, projectId, { primary: true });

    if (row) {
        await context.db.patch("projectRuleFiles", row._id, { files, updatedAt: context.now });

        return;
    }

    try {
        await context.db.insert("projectRuleFiles", { files, projectId, updatedAt: context.now });
    } catch (error) {
        if (isUniqueViolation(error)) {
            throw new LunoraError("CONFLICT", "The rule files were changed meanwhile. Reload them and save again.");
        }

        throw error;
    }
};
