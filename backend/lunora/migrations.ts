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

/**
 * The stored config gained an optional `chainSource` (`chat/lib/tool-run-config.ts`). Nothing to fill: no run had a chain
 * source before it, so no stored row could carry one, and a row without it falls back to the per-thread cap. This no-op
 * exists only because `lunora prepare` blocks any change to `toolApprovalRuns.config`'s shape that no migration covers
 * ("field toolApprovalRuns.config changed shape … add a data migration to convert them"), even an added optional key.
 */
export const addApprovalChainSource = defineMigration({
    id: "add-approval-chain-source",
    table: "toolApprovalRuns",
    // `undefined` leaves every row untouched (`MigrationTransform`).
    up: () => undefined,
});

/**
 * A group pause's snapshot gained an optional `group.fileIds` (`chat/group/validators.ts`), the files the turn's message
 * attached. Nothing to fill: a row without it gives the speakers after the pause no pattern rule files, as before. A
 * no-op for the same reason as {@link addApprovalChainSource}.
 */
export const addGroupPauseFileIds = defineMigration({
    id: "add-group-pause-file-ids",
    table: "toolApprovalRuns",
    up: () => undefined,
});

/** The options a row stored under `agentOptions` (the read path that is retired), in its own shape. */
interface LegacyAgentOptions {
    configOptions?: { category?: string; choices: { name: string; value: string }[]; currentValue: string; id: string; name: string }[];
    modes?: { available: { name: string; value: string }[]; current: string };
}

/**
 * The agent's options moved to the state the session row holds now (`agentState`, `optionResult`). A row that stored
 * `agentOptions` keeps them: they fill the fields its `agentState` lacks (its `agentOptionsAt` the state's time, when it has
 * no `agentStateAt`). A field the state already holds is newer and stands, empty lists included. Then `agentOptions` and
 * `agentOptionsAt` are dropped, since the schema no longer declares them.
 */
export const dropAgentOptionFields = defineMigration({
    id: "drop-agent-option-fields",
    table: "acpSessions",
    up: (document) => {
        const row: Record<string, unknown> = { ...document };
        const legacy = row.agentOptions as LegacyAgentOptions | undefined;

        if (legacy !== undefined) {
            const legacyState = {
                ...(legacy.configOptions !== undefined && { configOptions: legacy.configOptions }),
                ...(legacy.modes !== undefined && {
                    modes: {
                        available: legacy.modes.available.map((mode) => {
                            return { id: mode.value, name: mode.name };
                        }),
                        current: legacy.modes.current,
                    },
                }),
            };
            // A usage-only state keeps no options, so the legacy ones are its only copy: they fill only the fields it lacks.
            const agentState = { ...legacyState, ...(row.agentState as Record<string, unknown> | undefined) };

            if (Object.keys(agentState).length > 0) {
                row.agentState = agentState;

                if (row.agentStateAt === undefined && typeof row.agentOptionsAt === "number") {
                    row.agentStateAt = row.agentOptionsAt;
                }
            }
        }

        delete row.agentOptions;
        delete row.agentOptionsAt;

        return row as typeof document;
    },
});

/** The event #580 posted for a session's options (`session_options`), as a stored chunk still holds it. */
type LegacySessionOptions = {
    kind: "session_options";
    options?: {
        configOptions?: unknown[];
        modes?: { available: { name: string; value: string }[]; current: string };
    };
};

/**
 * A stored `session_options` chunk becomes the `session_state` event that carries the same options now. Its option lists keep
 * their shape. A mode's identifier is `id` in `session_state` (`value` in the old list). The old event held no time, so the
 * chunk's creation time stands in for it. Chunks of other events are left as they are.
 */
export const sessionOptionsToSessionState = defineMigration({
    id: "session-options-to-session-state",
    table: "persistentChunks",
    up: (document) => {
        const { _creationTime: created, event } = document as unknown as { _creationTime?: number; event?: LegacySessionOptions | { kind: string } };

        if (event === undefined || event.kind !== "session_options") {
            return undefined;
        }

        const { options = {} } = event as LegacySessionOptions;
        const { modes } = options;
        const converted = {
            at: typeof created === "number" ? created : 0,
            kind: "session_state",
            ...(options.configOptions !== undefined && { configOptions: options.configOptions }),
            ...(modes !== undefined && {
                modes: {
                    available: modes.available.map((mode) => {
                        return { id: mode.value, name: mode.name };
                    }),
                    current: modes.current,
                },
            }),
        };

        return { ...document, event: converted } as typeof document;
    },
});

/**
 * The agent's advertised commands (`availableCommands`) joined the state a session row holds. The field is optional and a
 * row written before it simply has none, so nothing is rewritten: the migration only records the new shape in the baseline.
 */
export const addAgentCommandsToSessions = defineMigration({
    id: "add-agent-commands-acp-sessions",
    table: "acpSessions",
    // `undefined` leaves every row untouched (`MigrationTransform`).
    up: () => undefined,
});

/** The same additive change for the stored `session_state` events: an optional `availableCommands`, nothing rewritten. */
export const addAgentCommandsToChunks = defineMigration({
    id: "add-agent-commands-persistent-chunks",
    table: "persistentChunks",
    up: () => undefined,
});

/**
 * A delivered steer gained `textLength`, so a recovered reply can split a combined row into its steers. A row written
 * before it has none: recovery falls back to the row's own time for those steers (`chat/lib/recover-finished-reply.ts`).
 * Nothing is rewritten, so the old rows keep their meaning and the new key is optional.
 */
export const addSteerTextLength = defineMigration({
    id: "add-steer-text-length",
    table: "persistentStreams",
    up: () => undefined,
});

/**
 * The stored config gained an optional `mcpToolOrigins` (`chat/lib/tool-run-config.ts`): which server's tool each runtime name
 * stood for. Nothing to fill: a row without it is not held to an origin, as before it, and an origin cannot be told after
 * the fact. A no-op, so `lunora prepare` records the added optional key in the baseline.
 */
export const addApprovalToolOrigins = defineMigration({
    id: "add-approval-tool-origins",
    table: "toolApprovalRuns",
    // `undefined` leaves every row untouched (`MigrationTransform`).
    up: () => undefined,
});

/**
 * The stored config gained an optional `botLookup` (`chat/lib/tool-run-config.ts`): where a paused headless run found its bot.
 * Nothing to fill: a row without it looks the bot up by its thread, as before it. A no-op, so `lunora prepare` records the
 * added optional key in the baseline.
 */
export const addApprovalBotLookup = defineMigration({
    id: "add-approval-bot-lookup",
    table: "toolApprovalRuns",
    // `undefined` leaves every row untouched (`MigrationTransform`).
    up: () => undefined,
});

/**
 * A queued steer's not-typed mark (`persistentStreams.notTypedSteers`, `lib/not-typed-text.ts`) gained draft kinds:
 * forwarded messages, a reply sent on as a prompt, a suggestion, the prompt improver's rewrite, a gallery prompt and an
 * organization's value. Only the union widened, so every stored mark still fits. A no-op, so `lunora prepare` records the
 * wider shape in the baseline.
 */
export const widenNotTypedSteerDrafts = defineMigration({
    id: "widen-not-typed-steer-drafts",
    table: "persistentStreams",
    // `undefined` leaves every row untouched (`MigrationTransform`).
    up: () => undefined,
});

/**
 * The stored config gained an optional `projectId` (`chat/lib/tool-run-config.ts`): the project whose `auto` rule files a
 * paused run listed. Nothing to fill: a row without it offered no `instruction_read`, or reads no project's files. A no-op,
 * so `lunora prepare` records the added optional key in the baseline. (The rule files' own new `description` and `auto`
 * mode need none: `projectRuleFiles` is `.global()`, which a shard's data migration cannot read, and every stored file
 * still fits the wider shape.)
 */
export const addApprovalProjectId = defineMigration({
    id: "add-approval-project-id",
    table: "toolApprovalRuns",
    // `undefined` leaves every row untouched (`MigrationTransform`).
    up: () => undefined,
});
