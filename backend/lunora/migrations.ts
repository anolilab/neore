import { defineMigration } from "lunorash/server";

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
