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
 * `threads.isGroupChat` is no longer in the schema. A group chat's shape is `groupChat` now. No deployed build has written
 * the flag (`main` never had it), so this only clears it from rows written by a development build of this branch. A row
 * without the flag is skipped.
 */
export const dropThreadIsGroupChat = defineMigration({
    id: "drop-thread-is-group-chat",
    table: "threads",
    up: (document) => {
        if (!("isGroupChat" in document)) {
            return undefined;
        }

        const { isGroupChat: _dropped, ...rest } = document;

        return rest;
    },
});

/**
 * `skills.source` gained a `plugin` member (`{ type: "plugin", version }`). The change only adds a member: every stored
 * source already fits, so no row is rewritten. A row that is returned unchanged is skipped (`undefined`). The migration is
 * kept so the table's change has one on record, as the schema gate asks.
 */
export const noteSkillSourcePlugin = defineMigration({
    id: "note-skill-source-plugin",
    table: "skills",
    up: () => undefined,
});
