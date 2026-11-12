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

/**
 * The export runs' due time (`deleteAt`) became required. A run stored before it has none, so it is given one a time to live after
 * its creation: the time the sweep would have acted on it had it been set, so it is swept like any other run.
 */
export const backfillUsageExportRunDeleteAt = defineMigration({
    id: "backfill-usage-export-run-delete-at",
    table: "usageExportRuns",
    up: (document) => {
        if (document.deleteAt !== undefined) {
            return undefined;
        }

        // The sweep's time to live (`usage/gdpr.ts` EXPORT_PIECE_TTL_MS), written out: a migration keeps the value it was made with.
        return { ...document, deleteAt: (document.createdAt as number) + 24 * 60 * 60 * 1000 };
    },
});
