import { defineMigration } from "lunorash/server";

import { getMaxSteps } from "./chat/lib/auto-continue";

/**
 * A pending approval's stored config gained optional keys for a sub-agent's pause (`chat/lib/tool-run-config.ts`:
 * `headlessApproved`, `subAgentRunId`). A row written before them has none, which means an interactive run. This writes
 * `headlessApproved` as an empty list on those rows: the same meaning, in the shape the schema describes.
 */
export const addHeadlessApproved = defineMigration({
    id: "add-headless-approved",
    table: "toolApprovalRuns",
    up: (document) => {
        const config = (document.config ?? {}) as Record<string, unknown>;

        return { ...document, config: { ...config, headlessApproved: config.headlessApproved ?? [] } };
    },
});

/**
 * The stored config gained `stepsLeft` (and `contextFromOrder`) for a sub-agent child's pause. Only such a row
 * (`subAgentRunId`) gets `stepsLeft`, its full budget: the budget it already resumed with. Every other row is left as it
 * is, so an interactive continuation keeps a full budget each time, and a row without `contextFromOrder` keeps the usual
 * window.
 */
export const addHeadlessResumeBounds = defineMigration({
    id: "add-headless-resume-bounds",
    table: "toolApprovalRuns",
    up: (document) => {
        const config = (document.config ?? {}) as Record<string, unknown>;

        // `undefined` leaves the row untouched: skipped, not rewritten (`MigrationTransform`).
        if (config.subAgentRunId === undefined || config.stepsLeft !== undefined) {
            return undefined;
        }

        return { ...document, config: { ...config, stepsLeft: getMaxSteps(config.shouldAutoContinue === true) } };
    },
});

/** The approval snapshot fields this migration reads and writes; the rest of the row is copied through unchanged. */
interface ApprovalConfig {
    group?: { organizationId?: string };
    organizationId?: string;
}

/**
 * Records the organization on paused approvals that predate `config.organizationId`. Only pending rows can be
 * continued, so resolved rows are left as they are. The continuation already reads the thread's stored organization
 * first, then the group snapshot's, so this only makes the snapshot self-contained: no cap decision changes.
 *
 * There is no `down`. A rollback cannot tell the rows this migration filled in from rows that an approval created
 * after it recorded its own organization, so clearing the field would erase real data. Undoing it is left to a
 * manual, reviewed change.
 */
export const backfillApprovalOrganization = defineMigration({
    id: "backfill-approval-organization",
    table: "toolApprovalRuns",
    up: async (document, ctx) => {
        const config = document.config as ApprovalConfig;

        if (document.status !== "pending" || config.organizationId !== undefined) {
            return undefined;
        }

        const thread = await ctx.db.get("threads", String(document.threadId));
        const threadOrganizationId = thread?.organizationId;
        const organizationId = typeof threadOrganizationId === "string" ? threadOrganizationId : config.group?.organizationId;

        if (!organizationId) {
            return undefined;
        }

        return { ...document, config: { ...config, organizationId } };
    },
});
