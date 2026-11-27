import { defineMigration } from "lunorash/server";

import { typedTextColumn } from "./agent/shared";
import type { Message } from "./agent/validators";
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

/**
 * A queued steer's not-typed mark gained `collaborator`: another person's message in a shared chat put back into the
 * composer (Restore to input). Only the union widened, so every stored mark still fits. A no-op, so `lunora prepare`
 * records the wider shape in the baseline.
 */
export const widenNotTypedSteerCollaborator = defineMigration({
    id: "widen-not-typed-steer-collaborator",
    table: "persistentStreams",
    // `undefined` leaves every row untouched (`MigrationTransform`).
    up: () => undefined,
});

/**
 * A run's stored arguments (`persistentStreams.runArgs`, and `pause.run`) gained an optional `impersonated`: whether an
 * admin acting as the owner sent the turn (`chat/lib/streaming-run-args.ts`). Nothing to fill: a row without it reads as
 * not known, which gives the turn no saved login. A no-op, so `lunora prepare` records the added optional key.
 */
export const addRunArgsImpersonated = defineMigration({
    id: "add-run-args-impersonated",
    table: "persistentStreams",
    // `undefined` leaves every row untouched (`MigrationTransform`).
    up: () => undefined,
});

/**
 * The stored config gained an optional `impersonated` and `systemContext` (`chat/lib/tool-run-config.ts`): what the
 * saved-login verdict needs of the paused turn. Nothing to fill: a row without them gives its continuation no saved login.
 * A no-op, so `lunora prepare` records the added optional keys.
 */
export const addApprovalRunTurn = defineMigration({
    id: "add-approval-run-turn",
    table: "toolApprovalRuns",
    // `undefined` leaves every row untouched (`MigrationTransform`).
    up: () => undefined,
});

/**
 * A run's stored arguments (`runArgs`, `pause.run`) gained an optional `systemContext` (`chat/lib/streaming-run-args.ts`),
 * and a held steer's mark (`notTypedSteers`) the `extension` kind. Nothing to fill: a resume of a run stored without
 * kinds runs as `unrecorded` and gets no saved login, and no stored mark names the new kind. A no-op, so `lunora prepare`
 * records both in the baseline.
 */
export const addRunArgsSystemContext = defineMigration({
    id: "add-run-args-system-context",
    table: "persistentStreams",
    // `undefined` leaves every row untouched (`MigrationTransform`).
    up: () => undefined,
});

/**
 * A session's stored purchase looks (`browserSessions.purchaseLooks`) gained an optional `browser`: the renderer session the look
 * was read on (`browser/functions.ts#recordPurchaseLook`). Nothing to fill: a look without it reads as another browser, so its
 * approved click is refused (`browser-node.ts`). A no-op, so `lunora prepare` records the added optional key in the baseline.
 */
export const addPurchaseLookBrowser = defineMigration({
    id: "add-purchase-look-browser",
    table: "browserSessions",
    // `undefined` leaves every row untouched (`MigrationTransform`).
    up: () => undefined,
});

/**
 * Messages gained an optional `typedText` (`agent/shared.ts#typedTextColumn`) and its `typed_text_search` index, which the
 * composer's prompt search reads. This fills it on rows saved before it, by the same rule every write uses
 * (`typedTextColumn` over the stored `message` parts, never the flattened `text`), so an older prompt can be found too.
 * An unmarked row in a messenger thread is read as messenger's text (its attachment lines are not typed), which takes one
 * read of the thread, made only for a row whose typed text that changes.
 * A row with nothing typed (only a quote, an attachment or a placeholder), a non-user row and a row kept out of search
 * (no `text`) stay unset, as do rows that already have the column. Only `typedText` is added: `text`, the deletion
 * marks and the thread's lock are copied through, and the search still drops a locked or deleted row when it reads.
 *
 * The runner walks each shard on its own, `batchSize` rows per batch, and records its cursor after every batch, so a run
 * stopped by a batch cap or a failure resumes where it left off. A batch is one read of 32 rows and one rewrite per
 * changed row. There is no `down`: a rollback cannot tell a filled row from one a write stamped after this ran.
 *
 * `deploy.yml` runs it after each deploy, with every other migration in this file (`scripts/run-data-migrations.ts`).
 * Until it has run, the prompt search finds only prompts sent after the deploy.
 */
export const backfillMessageTypedText = defineMigration({
    batchSize: 32,
    id: "backfill-message-typed-text",
    table: "messages",
    up: async (document, context) => {
        if (document.typedText !== undefined) {
            return undefined;
        }

        const message = document.message as Message | undefined;
        const text = document.text as string | undefined;
        let typedText = typedTextColumn(message, text);

        // A messenger row saved before its part was marked (`messengerTextPart`) reads as typed up to its attachment lines
        // only in a messenger thread; anywhere else such a line was typed. The thread is read only when that would change.
        const asMessenger = typedTextColumn(message, text, { messengerOrigin: true });

        if (asMessenger !== typedText && typeof document.threadId === "string") {
            const thread = await context.db.get("threads", document.threadId);

            if (thread?.messengerConnectionId !== undefined && thread?.messengerConnectionId !== null) {
                typedText = asMessenger;
            }
        }

        // `undefined` leaves the row untouched: skipped, not rewritten (`MigrationTransform`).
        return typedText === undefined ? undefined : { ...document, typedText };
    },
});

/**
 * A person's organization-project runner defaults (`userSettings.projectRunnerDefaults`, `acp/lib/project-runner.ts`)
 * gained an optional `threadAt`, the start time of the thread an entry came from. Nothing to fill: an entry without it is
 * read as older than any thread and any move. A no-op, so `lunora prepare` records the added optional key in the baseline.
 */
export const addProjectRunnerThreadAt = defineMigration({
    id: "add-project-runner-thread-at",
    table: "userSettings",
    // `undefined` leaves every row untouched (`MigrationTransform`).
    up: () => undefined,
});

/**
 * Each entry of `userSettings.projectRunnerDefaults` gained an optional `threadId`, the id of the thread it came from: of two
 * threads started in the same millisecond, the one with the greater id keeps the default (`agent/table-writes.ts#runnerReplaces`).
 * Nothing to fill: an entry without it loses a tie. A no-op, so `lunora prepare` records the added optional key in the baseline.
 */
export const addProjectRunnerThreadId = defineMigration({
    id: "add-project-runner-thread-id",
    table: "userSettings",
    // `undefined` leaves every row untouched (`MigrationTransform`).
    up: () => undefined,
});

/**
 * `pullRequestThreads.watchActive` (true exactly while a watch runs) is what `setPullRequestWatch` counts a person's
 * watches through (`by_user_and_watchActive`). A watch started before that field has a `watch` with no `stoppedAt` and no
 * flag, so the count could not see it. This sets `watchActive: true` on such a row: a running watch on a live thread.
 * A stopped watch, a watch on a deleted thread, a row without a watch and a row already flagged are left as they are,
 * and only `watchActive` is added: `watch`, `watchPending` and every other field are copied through.
 *
 * Idempotent: a flagged row is skipped, so a second run changes nothing. There is no `down`: a rollback cannot tell a
 * filled row from one a watch start flagged after this ran.
 */
export const backfillPullRequestWatchActive = defineMigration({
    id: "backfill-pull-request-watch-active",
    table: "pullRequestThreads",
    // `undefined` leaves the row untouched: skipped, not rewritten (`MigrationTransform`).
    up: (document) => {
        const watch = document.watch as { stoppedAt?: number } | null | undefined;

        if (!watch || watch.stoppedAt !== undefined || document.threadDeleted === true || document.watchActive === true) {
            return undefined;
        }

        return { ...document, watchActive: true };
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
