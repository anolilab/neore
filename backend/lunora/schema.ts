/**
 * Lunora schema — hand-maintained. This file IS the source of truth.
 *
 * It began as generated output, but the generator and the schema it read from
 * are both gone; edit this file directly.
 *
 * Storage tiers (`.global()` / `.shardBy()` / root DO) are chosen per table
 * below. The headline rule: a mutation runs inside ONE Durable Object, so
 * tables written together are sharded together (the whole chat domain is keyed
 * by `userId`, not `threadId`).
 */
import { paymentExtension } from "@lunora/payment";
import { MAX_THREAD_TITLE_INSTRUCTIONS_LENGTH } from "@neore/ai/constants";
import { defineSchema, defineTable, v } from "lunorash/server";

import { vAcpAgentState, vAcpOptionResult, vAcpSessionStatus, vHostEndReason, vHostEvent, vHostState } from "./acp/validators";
import { vAgentRef } from "./agent/agent-switch-validators";
import { threadSearchMessageTriggers, threadSearchTriggers } from "./agent/thread-search-triggers";
import { vGoalRunConfig, vGoalStatus as vThreadGoalStatus, vGoalStopReason, vGoalVerdict, vPinnedGoal } from "./chat/goals/validators";
import { vGroupChat } from "./chat/group/validators";
import { runStreamingAgentFields } from "./chat/lib/streaming-run-args";
import { vToolRunConfig } from "./chat/lib/tool-run-config";
import { vCodingAgentAssignment, vCodingAgentId, vCodingAgentRunStatus } from "./coding-agents/validators";
import { vOAuthClientRecord, vOAuthFlow, vOAuthTarget } from "./connectors/lib/validators";
import {
    vAcpOffer,
    vDeviceCallPhase,
    vDeviceCallStatus,
    vDeviceManifestTool,
    vDevicePlatform,
    vDeviceTaintSource,
    vDeviceTransport,
} from "./devices/validators";
import { embed } from "./embed";
import { vFeedbackKind } from "./feedback/validators";
import {
    vEvalCheck,
    vEvalCheckResult,
    vEvalDatasetKind,
    vEvalResultStatus,
    vEvalRunStatus,
    vEvalSummary,
    vEvalTarget,
    vJudgeVerdict,
    vRetrievalMetrics,
} from "./evals/validators";
import { AUDIT_TABLES, auditTriggersFor } from "./lib/audit-triggers";
import { vNotTypedMarks } from "./lib/not-typed-text-validator";
import { vMemoryEvidence } from "./memory/evidence";
import { vCapabilityReport } from "./lib/capability-report";
import { notificationInputFields } from "./notifications/validators";
import {
    vCachedRequest,
    vDraftComment,
    vGuideFailure,
    vGuideProposal,
    vGuideSource,
    vGuideStatus,
    vGuideStop,
    vPollStatus,
    vReviewVerdict,
} from "./source-control/validators";
import { vSkillConfig } from "./skills/validators";
import {
    vDispatchSource,
    vSubAgentRoles,
    vSubAgentRunMode,
    vSubAgentRunner,
    vSubAgentRunRole,
    vSubAgentRunStatus,
    vWorkerPolicy,
} from "./sub-agents/validators";
import {
    vGoalStatus,
    vTaskRunDestination,
    vTaskRunNoticeReason,
    vTaskRunOrigin,
    vTaskRunStatus,
    vTaskSkipReason,
    vTaskSuggestionStatus,
    vTaskStatus,
    vVerdict,
} from "./tasks/validators";
import { vEventSource, vEventState, vWebhookSignatureScheme } from "./triggers/validators";

/** Hoisted so `streamDeltasFields` is readable as a value, not just a type. */
export const streamDeltasFields = {
    end: v.number(),
    parts: v.array(v.any()),
    start: v.number(),
    streamId: v.id("streamingMessages"),
};

/**
 * Hoisted so `streamingMessagesFields` is readable as a value, not just a type.
 *
 * Split at `state` because `agent/streams:create` takes everything BUT `state`
 * (it computes the initial value itself). The literal is the narrow set and the
 * doc fields spread it, rather than `.input(omit(streamingMessagesFields,
 * ["state"]))` — codegen resolves `.input()` from an object literal or a `const`
 * object literal it names, never from a call, and silently emits `{}` arguments
 * for one. See `vThreadCreateFields` in `agent/validators.ts`.
 */
export const streamingMessagesFieldsWithoutState = {
    agentName: v.optional(v.string()),
    format: v.optional(v.union(v.literal("UIMessageChunk"), v.literal("TextStreamPart"))),
    model: v.optional(v.string()),
    order: v.number(),
    provider: v.optional(v.string()),
    providerOptions: v.optional(v.record(v.string(), v.record(v.string(), v.any()))),
    // The run's stream id (`persistentStreams`), which the saved rows of the reply carry as `replyId`.
    runStreamId: v.optional(v.string()),
    stepOrder: v.number(),
    threadId: v.id("threads"),
    userId: v.optional(v.string()),
};

export const streamingMessagesFields = {
    ...streamingMessagesFieldsWithoutState,
    state: v.union(
        v.object({
            kind: v.literal("streaming"),
            lastHeartbeat: v.number(),
            timeoutFnId: v.optional(v.string()),
        }),
        v.object({
            cleanupFnId: v.optional(v.string()),
            endedAt: v.number(),
            kind: v.literal("finished"),
        }),
        v.object({
            kind: v.literal("aborted"),
            reason: v.string(),
        }),
    ),
    // Denormalised from `state.kind` — Lunora cannot index nested field paths.
    // It is NOT an input: `agent/streams:create` and every `state` patch own
    // both halves, because the two must move together or the three
    // `threadId_state_order_stepOrder` index reads find nothing.
    stateKind: v.union(v.literal("streaming"), v.literal("finished"), v.literal("aborted")),
};

export const schema = defineSchema({
    account: defineTable({
        accessToken: v.optional(v.string()),
        accessTokenExpiresAt: v.optional(v.number()),
        // better-auth's own name for the provider's id for this account
        // (`accountSchema` in `@better-auth/core/db/schema/account`). It was
        // `providerAccountId` here — NextAuth's spelling, carried over from the
        // pre-Lunora schema — which nothing in this repo ever read, so the drift
        // only surfaced at runtime as `D1_ERROR: table account has no column
        // named accountId` on the first sign-up.
        accountId: v.string(),
        createdAt: v.number(),
        idToken: v.optional(v.string()),
        // better-auth 1.7 writes this on OAuth/OIDC accounts. These auth tables
        // are hand-maintained copies of better-auth's own schema, so each of its
        // releases can add a column here that nothing in this repo notices until
        // a runtime `no column named …`.
        issuer: v.optional(v.string()),
        password: v.optional(v.string()),
        providerId: v.string(),
        refreshToken: v.optional(v.string()),
        refreshTokenExpiresAt: v.optional(v.number()),
        scope: v.optional(v.string()),
        updatedAt: v.number(),
        userId: v.string(),
    })
        .externallyManaged()
        .global()
        .index("accountId_providerId", ["accountId", "providerId"])
        .index("providerId_userId", ["providerId", "userId"])
        .index("userId", ["userId"])
        .triggers((t) => auditTriggersFor(t, "account", AUDIT_TABLES["account"]!)),

    /**
     * An account whose pins are being moved or erased: a merge of a guest into a new account, or an account erasure. While a row exists
     * for a user, that user cannot add pins (`lib/account-moves.ts`). Global, so every shard reads it; written before the move starts.
     */
    accountMoves: defineTable({
        createdAt: v.number(),
        kind: v.union(v.literal("erasing"), v.literal("importing"), v.literal("merging")),
        userId: v.string(),
    })
        .global()
        .index("by_user", ["userId"]),

    // One coding-agent session on a paired device (`acp/`): the thread it runs
    // in, which agent and folder (labels only; paths never leave the desktop) and
    // what it reported at the handshake. `hostSessionId` is the desktop's own id
    // for the session, which makes `session_open` idempotent on redelivery.
    acpSessions: defineTable({
        agentKey: v.string(),
        agentLabel: v.string(),
        // What the agent reported about itself outside its turns: context use and cost, and the slash commands it advertises
        // (`availableCommands`, replaced whole). Unset until it reports.
        agentState: v.optional(vAcpAgentState),
        // The `at` of the newest report applied to `agentState`; an older report is dropped.
        agentStateAt: v.optional(v.number()),
        // The desktop's sequence number of the newest report applied to `agentState`. Unset until a report carries one.
        agentStateSeq: v.optional(v.number()),
        capabilities: v.optional(vCapabilityReport),
        createdAt: v.number(),
        deviceId: v.id("devices"),
        folderId: v.string(),
        folderLabel: v.string(),
        // When a prompt sent from the app carried the handoff this session was opened for (`acp/lib/send-turn.ts`). A prompt typed
        // in the computer's own window is a turn too but carries none, so a turn alone does not show the agent got it. Unset: not yet.
        handoffSentAt: v.optional(v.number()),
        hostSessionId: v.string(),
        // An imported session (S6) takes its transcript from the host a turn at a time: `importedTurns` is how many the backend
        // holds, `importState` whether the host has sent the end. Unset on a session that ran here.
        importedTurns: v.optional(v.number()),
        importState: v.optional(v.union(v.literal("importing"), v.literal("done"))),
        lastEventAt: v.optional(v.number()),
        nativeSessionId: v.optional(v.string()),
        // How the agent answered the last change of one of its options made from the app (`acp_set_config`). Unset until one was made.
        optionResult: v.optional(vAcpOptionResult),
        status: vAcpSessionStatus,
        // The untrusted content the agent was handed when it took over (`agent/thread-summary-taint.ts`), signed onto every
        // prompt it is sent. Unset: it was handed none.
        taintedBy: v.optional(v.array(vDeviceTaintSource)),
        threadId: v.id("threads"),
        updatedAt: v.number(),
        userId: v.string(),
    })
        .shardBy("userId")
        .index("by_threadId", ["threadId"])
        .index("by_userId_status", ["userId", "status"])
        // Also serves "every session of a device" (a revoke reads the prefix).
        .index("by_deviceId_hostSessionId", ["deviceId", "hostSessionId"])
        // One thread per agent session (S6): an import finds a session that already exists, imported or run here.
        .index("by_userId_agentKey_nativeSessionId", ["userId", "agentKey", "nativeSessionId"]),

    actionCache: defineTable({
        expiresAt: v.number(),
        key: v.string(),
        name: v.string(),
        value: v.any(),
    })
        .index("by_key", ["key"])
        .index("by_name", ["name"])
        .index("by_expiresAt", ["expiresAt"])
        .global(),

    aiUserPreferences: defineTable({
        // Opt-in quick check that approves low-risk `ask` tool calls (chat/lib/low-risk-approval.ts). Absent = off.
        // Server-written only (`chat_tool_permissions.setAutoApproveLowRisk`); `auth/fields.ts` deliberately omits it.
        autoApproveLowRisk: v.optional(v.boolean()),
        autoDetectComplexity: v.optional(v.boolean()),
        autoMediaEnrichment: v.optional(v.boolean()),
        // How the agent's browser clicks: "page" (absent, the default) checks and clicks in the page; "pointer" clicks for real
        // except a purchase or an approved click; "all" clicks for real after a check. Server-written (`chat_functions.setBrowserClickMode`).
        browserClickMode: v.optional(v.union(v.literal("page"), v.literal("pointer"), v.literal("all"))),
        browserSettings: v.optional(
            v.object({ domainAllowlist: v.optional(v.array(v.string())), domainBlocklist: v.optional(v.array(v.string())), enabled: v.optional(v.boolean()) }),
        ),
        // Who a coding-agent pull request's commits are made as: the agent (absent, the default) or the person who
        // started the run, with the agent as co-author. Server-written only (`coding_agents.functions.setCodingAgentCommitIdentity`).
        codingAgentCommitIdentity: v.optional(v.union(v.literal("agent"), v.literal("user"))),
        customAIProviders: v.optional(v.any()),
        customization: v.optional(v.any()),
        customModels: v.optional(v.any()),
        defaultModels: v.optional(v.any()),
        enableDatasource: v.optional(v.boolean()),
        enableKnowledge: v.optional(v.boolean()),
        enablePlanner: v.optional(v.boolean()),
        generalProviders: v.optional(v.any()),
        // Servers whose tools the quick check may judge (chat/lib/low-risk-trust.ts): an MCP server by name AND url, a connector by slug.
        // Absent = none, bounded by `MAX_TRUSTED_SERVERS`. Server-written only (`chat_tool_permissions.setLowRiskTrustedServer`); `auth/fields.ts` omits it.
        lowRiskTrustedServers: v.optional(v.array(v.string())),
        /**
         * Header values the agent obtained with `requestSecret` for one of `mcpServers`, encrypted
         * (`lib/encryption.ts`, `mcp-headers`) and bound to the server's name AND url. Apart from
         * `mcpServers[].headers` on purpose: that list is plaintext the Settings page shows and writes back,
         * and the audit history snapshots it; this column is server-only, left out of the client view
         * (`redactPreferences`) and read only where a run builds its servers (`getMCPServersQuery`).
         */
        mcpSecretHeaders: v.optional(v.array(v.object({ encryptedValue: v.string(), header: v.string(), server: v.string(), url: v.string() }))),
        mcpServers: v.optional(
            v.array(
                v.object({
                    enabled: v.boolean(),
                    headers: v.optional(v.array(v.object({ key: v.string(), value: v.string() }))),
                    icon: v.optional(v.string()),
                    name: v.string(),
                    protocol: v.union(v.literal("sse"), v.literal("http")),
                    url: v.string(),
                }),
            ),
        ),
        messengerKeys: v.optional(v.any()),
        modelFilterRules: v.optional(
            v.object({
                allowedModels: v.optional(v.array(v.string())),
                allowedProviders: v.optional(v.array(v.string())),
                allowedRegions: v.optional(v.array(v.string())),
                blockedCreators: v.optional(v.array(v.string())),
                blockedModels: v.optional(v.array(v.string())),
                blockedProviders: v.optional(v.array(v.string())),
                blockedRegions: v.optional(v.array(v.string())),
                denyDataCollection: v.optional(v.boolean()),
                requireZDR: v.optional(v.boolean()),
            }),
        ),
        modelOverrides: v.optional(v.any()),
        providerApiKeys: v.optional(v.any()),
        searchIncludeSourcesByDefault: v.optional(v.boolean()),
        searchProvider: v.optional(v.string()),
        selectedModel: v.optional(v.string()),
        showTimestamps: v.optional(v.boolean()),
        // Per-tool permission overrides, keyed `builtin:<tool>` / `mcp:<server>:<tool>`
        // (see chat/lib/tool-permissions.ts). Absent key = the tool's default mode.
        // Time-boxed allows: permission key -> the epoch ms it lapses (chat/lib/tool-permission-grants.ts).
        // Server-written only; `auth/fields.ts` deliberately omits it, so no client input can set one.
        toolPermissionGrants: v.optional(v.record(v.string(), v.number())),
        toolPermissions: v.optional(v.record(v.string(), v.union(v.literal("auto"), v.literal("ask"), v.literal("off")))),
        userId: v.string(),
    })
        .shardBy("userId")
        .index("by_userId", ["userId"])
        .triggers((t) => auditTriggersFor(t, "aiUserPreferences", AUDIT_TABLES["aiUserPreferences"]!)),

    /**
     * `@better-auth/api-key`'s table. Declared here for the same reason every
     * other better-auth table is: `src/server.ts` does not run `ensureMigrated`,
     * so nothing else creates it.
     *
     * It was simply missing — the `apiKey()` plugin is enabled in `auth.ts`, but
     * no table backed it, so every API-key route would have died on
     * `no such table: apikey`. Column names, types and the three indexed fields
     * are the plugin's own (`apiKeySchema` in `@better-auth/api-key`); `date`
     * fields are numbers because the Lunora adapter sets `supportsDates: false`.
     */
    apikey: defineTable({
        configId: v.string(),
        createdAt: v.number(),
        enabled: v.optional(v.boolean()),
        expiresAt: v.optional(v.number()),
        key: v.string(),
        lastRefillAt: v.optional(v.number()),
        lastRequest: v.optional(v.number()),
        metadata: v.optional(v.string()),
        name: v.optional(v.string()),
        permissions: v.optional(v.string()),
        prefix: v.optional(v.string()),
        rateLimitEnabled: v.optional(v.boolean()),
        rateLimitMax: v.optional(v.number()),
        rateLimitTimeWindow: v.optional(v.number()),
        referenceId: v.string(),
        refillAmount: v.optional(v.number()),
        refillInterval: v.optional(v.number()),
        remaining: v.optional(v.number()),
        requestCount: v.optional(v.number()),
        start: v.optional(v.string()),
        updatedAt: v.number(),
    })
        .externallyManaged()
        .global()
        .index("configId", ["configId"])
        .index("key", ["key"])
        .index("referenceId", ["referenceId"]),

    auditLog: defineTable({
        action: v.string(),
        adminEmail: v.string(),
        adminId: v.string(),
        details: v.optional(v.string()),
        ipAddress: v.optional(v.string()),
        targetUserEmail: v.optional(v.string()),
        targetUserId: v.optional(v.string()),
        timestamp: v.number(),
    })
        .global()
        .index("adminId", ["adminId"])
        .index("targetUserId", ["targetUserId"])
        .index("action", ["action"])
        .index("timestamp", ["timestamp"]),

    // A reference whose account was erased. A late Creem event for it must not recreate a payment row. The id is kept
    // only so that refusal can be made; it names no one once the account row is gone.
    billingErasures: defineTable({
        erasedAt: v.number(),
        referenceId: v.string(),
    })
        // Not `.global()`: the tombstone lives on the root shard with the payment rows it guards, so one mutation
        // writes both or neither.
        .index("by_referenceId", ["referenceId"]),

    /**
     * Who created each bot, kept for as long as the bot id can appear on a memory. A global table: a memory is written on
     * the shard of the person it belongs to, and a shared chat's bot lives on its owner's shard, so the write cannot read
     * the bot row there. Written by `createBot`; a row outlives its bot (a deleted bot still names its owner) and is
     * erased with its owner (`bots/gdpr.ts`). `deletedAt` is set by `deleteBot`, so the memory list can tell a shared bot
     * that is gone from one that is still live; a deleted bot's row is removed 90 days later (`bots/owner.ts`,
     * `BOT_OWNER_TOMBSTONE_TTL_MS`), so the table holds live bots and recent deletions only. Bots created before this
     * table have no row.
     */
    botOwners: defineTable({
        botId: v.id("bots"),
        createdAt: v.number(),
        deletedAt: v.optional(v.number()),
        ownerId: v.string(),
    })
        .global()
        .index("by_botId", ["botId"])
        .index("by_ownerId", ["ownerId"]),

    /**
     * A persistent teammate: a named persona (instructions + model) the user
     * chats with and schedules routines for. Its threads, routines, memories and
     * computer carry `botId`; deleting the bot unlinks nothing, so anything still
     * pointing at it falls back to the plain assistant (`bots/functions.ts`).
     */
    bots: defineTable({
        computerEnabled: v.boolean(),
        createdAt: v.number(),
        description: v.optional(v.string()),
        instructions: v.string(),
        // Set when an admin acting as the owner wrote the name or instructions (both reach the system prompt), and kept:
        // they are not the owner's words, so a run as this bot gets no saved login (`vault/site-login-turn.ts`).
        instructionsByImpersonator: v.optional(v.literal(true)),
        model: v.string(),
        name: v.string(),
        // The mode a new chat with this bot starts in (`chat/lib/thread-permission-mode.ts`); absent = the default. A run
        // nobody watches takes it only when it asks more (`unattendedMode` in `chat/lib/tool-permissions.ts`).
        permissionMode: v.optional(v.union(v.literal("supervised"), v.literal("auto"), v.literal("full"))),
        // Which tools the bot's runs keep (`bots/tool-selection.ts`); absent = every tool. It only removes tools.
        toolSelection: v.optional(v.object({ allow: v.optional(v.array(v.string())), exclude: v.array(v.string()) })),
        updatedAt: v.number(),
        userId: v.string(),
    })
        .shardBy("userId")
        .index("by_userId", ["userId"]),

    browserActions: defineTable({
        // `login`: a saved-login fill (`chat/tools/site-login-node.ts`). Its row names the site, never the username or password.
        action: v.union(
            v.literal("navigate"),
            v.literal("screenshot"),
            v.literal("click"),
            v.literal("type"),
            v.literal("extract"),
            v.literal("scroll"),
            v.literal("login"),
        ),
        /**
         * A person in control of the browser did this: the session's `owner`, or a `collaborator` they shared the chat
         * with; absent: the agent. A kind, never a user id: a collaborator's id here would outlive their account.
         */
        actor: v.optional(v.union(v.literal("collaborator"), v.literal("owner"))),
        durationMs: v.optional(v.number()),
        errorMessage: v.optional(v.string()),
        sessionId: v.id("browserSessions"),
        success: v.number(),
        target: v.optional(v.string()),
        timestamp: v.number(),
        value: v.optional(v.string()),
    }).index("by_sessionId_timestamp", ["sessionId", "timestamp"]),

    browserExtensions: defineTable({
        browserInfo: v.optional(v.string()),
        capabilities: v.optional(v.array(v.string())),
        extensionId: v.string(),
        extensionVersion: v.optional(v.string()),
        lastSeenAt: v.optional(v.number()),
        pairedAt: v.optional(v.number()),
        pairingCode: v.optional(v.string()),
        status: v.union(v.literal("pending"), v.literal("paired"), v.literal("revoked")),
        userId: v.string(),
    })
        .shardBy("userId")
        .index("by_userId_status", ["userId", "status"])
        .index("by_pairingCode", ["pairingCode"])
        .index("by_extensionId", ["extensionId"]),

    /**
     * A site whose check (a human verification, a sign-in the agent cannot pass) the person was asked to clear during
     * one reply (`run`: the reply key, `ToolCtx.replyKey`, the reply's first stream; the prompt, then the thread, for a
     * run that sets none): asked at most once per site per reply (`browser/human-check.ts`).
     */
    browserHumanChecks: defineTable({
        askedAt: v.number(),
        /** The check was found only in the page's text: a later read too long to read cannot show it gone. */
        inText: v.optional(v.boolean()),
        /** The agent said a person is needed (`needs_person`, e.g. a sign-in wall) rather than a check being detected. */
        reported: v.optional(v.boolean()),
        /**
         * The person's answer on the card (`browser/human-check-card.ts#resolveHumanCheck`): `done` (cleared it), `declined`
         * (will not; the agent is told so and asks nobody about the site again in that reply). Set once, never changed.
         */
        resolution: v.optional(v.union(v.literal("declined"), v.literal("done"))),
        resolvedAt: v.optional(v.number()),
        run: v.string(),
        /** The page's host, `""` when it had no readable URL. */
        site: v.string(),
        threadId: v.id("threads"),
        /** The thread's owner, whose shard holds the row, whoever's turn asked. */
        userId: v.string(),
        /** The agent waited for the answer once (`wait_for_person`): a second wait on the ask returns at once. */
        waitedAt: v.optional(v.number()),
    })
        .shardBy("userId")
        // Unique: two actions of one reply that claim the same site at once insert one row, so the person is asked once.
        .index("by_threadId_site_run", ["threadId", "site", "run"], { unique: true })
        // An earlier reply's recent ask, for the first look after a hand back (`browser/human-check.ts#afterHandBack`).
        .index("by_threadId_site_askedAt", ["threadId", "site", "askedAt"])
        // The run's latest ask on any site, which the agent's `wait_for_person` waits on.
        .index("by_threadId_run_askedAt", ["threadId", "run", "askedAt"])
        .index("by_userId", ["userId"]),

    browserSessions: defineTable({
        completedAt: v.optional(v.number()),
        connectUrl: v.optional(v.string()),
        /**
         * A person drives the browser (`browser/live-view.ts#takeControl`): the agent's actions are refused while
         * `until` is ahead. `by` is an opaque holder (`browser/live-view.ts#controlHolder`, a keyed hash of the session
         * and the person), never a user id: a collaborator's id here would outlive their account. Kept after it ends,
         * until an agent action has looked at the page the person left (told that they drove).
         * `ended`: how the person gave it back (`browser_closed`: the renderer closed or replaced the browser they drove);
         * absent once `until` passed is the idle timeout.
         */
        control: v.optional(
            v.object({
                by: v.string(),
                /** New on every claim and renewal: a failed claim drops the lease only while it is still this one. */
                claim: v.string(),
                ended: v.optional(v.union(v.literal("browser_closed"), v.literal("handed_back"), v.literal("left"))),
                /** A page the person asked for loads until then: the lease lasts at least as long. */
                navigatingUntil: v.optional(v.number()),
                /**
                 * A renewal's mint is still running: the claim it replaces, which the view holding it keeps using until the
                 * renewal settles (then it goes) or fails (then it is `claim` again).
                 */
                renewing: v.optional(v.string()),
                /** The view under `renewing` closed (handed back or left) while the renewal mints: a failed renewal ends the lease so. */
                renewingEnded: v.optional(v.union(v.literal("handed_back"), v.literal("left"))),
                since: v.number(),
                until: v.number(),
            }),
        ),
        currentUrl: v.optional(v.string()),
        /** When the action that wrote `currentUrl` started, so an older action finishing later does not overwrite it. */
        currentUrlStartedAt: v.optional(v.number()),
        errorMessage: v.optional(v.string()),
        extensionId: v.optional(v.string()),
        extensionVersion: v.optional(v.string()),
        /**
         * The deadlines of the browser actions in flight, one per action (its renderer deadline): each holds the browser
         * until it ends, and removes only its own hold, so overlapping actions never end each other's.
         */
        inUseHolds: v.optional(v.array(v.number())),
        lastActivityAt: v.number(),
        providerSessionId: v.optional(v.string()),
        /**
         * The target a purchase decision looked at, per tool call (`browser/functions.ts#recordPurchaseLook`): the approved
         * click is checked against it, so a page that changed in between is refused. The newest few are kept.
         */
        // `browser` is absent on a look written before it was recorded: such a look reads as another browser, so its click is refused.
        purchaseLooks: v.optional(v.array(v.object({ browser: v.optional(v.string()), target: v.string(), toolCallId: v.string() }))),
        /**
         * Tool calls whose decision target was pushed out of `purchaseLooks` before their approved click ran
         * (`browser/functions.ts#recordPurchaseLook`): such a click is refused, never run unchecked.
         */
        purchaseLostCalls: v.optional(v.array(v.string())),
        /**
         * The deadlines of the browser actions in flight that began while the row read the browser as reaped (or before it
         * named one): they keep a person from taking control until they end, but keep no browser alive, so a reaped one
         * is not offered while the renderer replaces it.
         */
        reapedHolds: v.optional(v.array(v.number())),
        source: v.optional(v.string()),
        startedAt: v.number(),
        status: v.string(),
        threadId: v.id("threads"),
        userId: v.string(),
    })
        .shardBy("userId")
        .index("by_userId", ["userId"])
        .index("by_threadId_status", ["threadId", "status"])
        .index("by_status", ["status"]),

    changelogCache: defineTable({
        entries: v.array(
            v.object({
                categories: v.array(v.object({ name: v.string() })),
                commentCount: v.number(),
                content: v.string(),
                createdAt: v.string(),
                date: v.string(),
                featuredImage: v.union(v.string(), v.null()),
                id: v.string(),
                isPublished: v.boolean(),
                slug: v.string(),
                state: v.string(),
                title: v.string(),
                updatedAt: v.string(),
                url: v.string(),
            }),
        ),
        fetchedAt: v.number(),
        total: v.number(),
    }).global(),

    /**
     * Who may attach a `chatFiles` row. The rows are deduplicated by hash and
     * SHARED — two users uploading the same bytes get the same row — so the
     * file itself cannot carry an owner. A grant is written whenever a user
     * stores (or re-stores) the bytes; `agent_files.getFileForUser` is the
     * check every client-supplied file id goes through.
     */
    chatFileAccess: defineTable({
        createdAt: v.number(),
        fileId: v.id("chatFiles"),
        userId: v.string(),
    })
        // `.global()`, like `chatFiles`: a grant is read wherever the file is
        // attached — a collaborator's upload attaches on the thread owner's shard.
        .global()
        .index("by_fileId_userId", ["fileId", "userId"])
        .index("by_userId", ["userId"]),

    /**
     * A chat file's export view: its name, type, hash and when it was stored. The GDPR export reads this instead of the file row, which
     * holds the extracted text the export does not carry and which a read meters whole. Written with the file (`addFile`) and erased with
     * it (the unused-file reaper), in the same mutation, so the two stay in step.
     */
    chatFileMetadata: defineTable({
        createdAt: v.number(),
        fileId: v.id("chatFiles"),
        filename: v.optional(v.string()),
        hash: v.string(),
        mediaType: v.string(),
    })
        // `.global()`, like `chatFiles`: it is written and erased with the file row, so it lives where that row does.
        .global()
        .index("by_fileId", ["fileId"]),

    /**
     * A chat-file storage object no row names (any more, or yet), to be deleted: written when a delete takes a file's last row
     * (`agent/files.ts#discardFileRow`), and before a store uploads to its own new key (`useExistingFile`'s `uploadKey`), which
     * the row that store writes takes back (`addFile`). It goes once the object delete returned (`deleteStoredObjects`); the sweep
     * deletes again every record past `deleteAfter` (`retryObjectDeletes`), so a failed delete or a store that died never leaves
     * bytes behind.
     */
    chatFileObjectDeletes: defineTable({
        /** The sweep takes the record up after this; a store's claim sets it beyond any sweep. */
        deleteAfter: v.number(),
        /**
         * `store`: an upload under way, which only its own store's row may take back (`addFile`). `delete`: the object is to go; a
         * sweep's claim of a due `store` record makes it one, so a store that comes back late finds it gone.
         */
        kind: v.union(v.literal("store"), v.literal("delete")),
        storageId: v.string(),
    })
        // `.global()`, like `chatFiles`: the stores and deletes it records run on any user's shard.
        .global()
        .index("by_storageId", ["storageId"])
        .index("by_deleteAfter", ["deleteAfter"]),

    chatFiles: defineTable({
        /**
         * Set by the conditional write that decides a delete (a save rollback, the unused-file sweep), before the row's grants,
         * metadata and row go. A reuse and a new reference are conditional on it being unset, so each lands before the decision
         * (and the delete skips the row) or finds it marked and stores its own row.
         */
        discardingAt: v.optional(v.number()),
        extractedText: v.optional(v.string()),
        extractionError: v.optional(v.string()),
        extractionStatus: v.optional(
            v.union(v.literal("pending"), v.literal("processing"), v.literal("completed"), v.literal("failed"), v.literal("unsupported")),
        ),
        filename: v.optional(v.string()),
        hash: v.string(),
        lastTouchedAt: v.number(),
        mediaType: v.string(),
        nsfwScores: v.optional(v.object({ drawing: v.number(), hentai: v.number(), neutral: v.number(), porn: v.number(), sexy: v.number() })),
        nsfwStatus: v.optional(v.union(v.literal("pending"), v.literal("checking"), v.literal("safe"), v.literal("blocked"), v.literal("failed"))),
        refcount: v.number(),
        /**
         * Set when a store found this row and handed it out again (`useExistingFile`, a racing `addFile`). That store's message
         * counts the row only when it saves, so until then `refcount` cannot show it: a save rollback (`discardUnsavedFiles`)
         * takes back only a row no other store reused.
         */
        reusedAt: v.optional(v.number()),
        storageId: v.string(),
        unreferencedSince: v.optional(v.number()),
    })
        // `.global()`: deduplicated by hash, so identical bytes stored by two
        // users share ONE row and its object (`agent-files/<sha256>/<uuid>`,
        // `lib/chat-file-key.ts`). Its refcount must see every user's
        // references — per-shard copies would each reap the object the other
        // still uses.
        .global()
        .index("hash_filename", ["hash", "filename"])
        // The rows naming one storage object (`lib/storage-ownership.ts`, `agent/files.ts`): a hash can have any number of rows.
        .index("by_storageId", ["storageId"])
        .index("refcount", ["refcount"]),

    /**
     * Which of an owner's chats hold which chat files. Written with every message
     * `fileIds` write (`changeMessageFiles`), read by the password-lock gate
     * (`fileGatedByLockedChat`) as one point lookup per locked chat. Keyed by the
     * thread OWNER and sharded with the owner's messages and passcodes. A link
     * stays after its message goes, which only over-gates; permanent thread
     * deletion and GDPR remove them.
     */
    chatFileThreads: defineTable({
        createdAt: v.number(),
        fileId: v.id("chatFiles"),
        threadId: v.id("threads"),
        userId: v.string(),
    })
        .shardBy("userId")
        .index("by_fileId_threadId", ["fileId", "threadId"])
        .index("by_threadId", ["threadId"])
        .index("by_userId", ["userId"]),

    chatImportJobs: defineTable({
        completedAt: v.optional(v.number()),
        createdAt: v.number(),
        currentStep: v.optional(v.string()),
        errorMessage: v.optional(v.string()),
        failedConversations: v.optional(v.number()),
        importedConversations: v.number(),
        progress: v.optional(v.number()),
        provider: v.union(v.literal("chatgpt"), v.literal("gemini"), v.literal("claude"), v.literal("claude-code"), v.literal("codex"), v.literal("neore")),
        r2Key: v.optional(v.string()),
        /** The run the job is on: a start or a restart mints it, and the workflow's finalize only acts for that run. */
        runId: v.optional(v.string()),
        status: v.union(v.literal("pending"), v.literal("processing"), v.literal("completed"), v.literal("failed")),
        totalConversations: v.number(),
        userId: v.string(),
    })
        .shardBy("userId")
        .index("by_user_and_status", ["userId", "status"])
        .index("by_user_and_createdAt", ["userId", "createdAt"]),

    cleanupConfigs: defineTable({
        batchSize: v.number(),
        isEnabled: v.boolean(),
        thresholdDays: v.number(),
    }).global(),

    cleanupLogs: defineTable({
        deletedCount: v.number(),
        durationMs: v.number(),
        eligibleCount: v.number(),
        mode: v.union(v.literal("dry_run"), v.literal("execute")),
        runAt: v.number(),
        triggeredBy: v.string(),
    })
        .global()
        .index("by_runAt", ["runAt"]),

    // A catalogue entry pointing at a provider-hosted remote MCP server.
    // `mcpWorkerUrl` is that server's URL (the name predates hosted servers).
    // OAuth is discovered from the server itself (`connectors/lib/mcp-oauth.ts`);
    // `oauthClientEnvPrefix` names a pre-registered client for servers without
    // dynamic client registration, `oauthAuthorizeParams` carries provider extras
    // such as Google's `access_type=offline`.
    /**
     * One delegation to a coding agent (Claude Code / Codex) in an E2B sandbox
     * (`coding-agents/`). Started by the chat tool (`toolCallId`, `threadId`) or
     * by a task assigned to a coding agent (`taskId`). `log` is a redacted,
     * tail-capped transcript the run view subscribes to; `diff` is kept so a PR
     * can be opened later from a fresh sandbox. Secrets are never stored here.
     */
    codingAgentRuns: defineTable({
        agent: vCodingAgentId,
        baseBranch: v.optional(v.string()),
        baseSha: v.optional(v.string()),
        branch: v.optional(v.string()),
        completedAt: v.optional(v.number()),
        createdAt: v.number(),
        diff: v.optional(v.string()),
        diffStat: v.optional(v.string()),
        diffTruncated: v.optional(v.boolean()),
        error: v.optional(v.string()),
        exitCode: v.optional(v.number()),
        // Set once, by whichever step ended the run first, when the follow-ups
        // (thread message, PR, task round) were claimed — makes them run once.
        finishedAt: v.optional(v.number()),
        // A "Fix setup" run: the setup step it repairs, which it skips so its agent can run (`setup-fix.ts`).
        fixesSetupStep: v.optional(v.string()),
        log: v.string(),
        // Byte offset into the sandbox's run log the poller has consumed.
        logOffset: v.optional(v.number()),
        openPr: v.boolean(),
        // The next poll's sequence number. Each poll (run or PR) claims its own
        // number before doing anything (`claimPoll`), so a redelivered poll from
        // the jobs queue cannot fork a second poll chain.
        pollSeq: v.optional(v.number()),
        // Posting the result waits for the PR the user asked for (`openPr`).
        prFollowUp: v.optional(v.boolean()),
        prompt: v.string(),
        // The PR sandbox (`startPullRequest`) and when it started, while one is in flight.
        prSandboxId: v.optional(v.string()),
        prStartedAt: v.optional(v.number()),
        // "pending" while a PR is being pushed — also what stops a second one starting.
        prStatus: v.optional(v.union(v.literal("pending"), v.literal("failed"))),
        prUrl: v.optional(v.string()),
        repoUrl: v.string(),
        sandboxId: v.optional(v.string()),
        // The step a `setup-failed` run stopped at and the capped, redacted end of its log, kept for "Fix setup".
        setupFailure: v.optional(v.object({ logTail: v.string(), step: v.string() })),
        // On a fix run: the failed run it repairs, so its finish notification can link where that run was started.
        setupFixOf: v.optional(v.id("codingAgentRuns")),
        // The newest "Fix setup" run started from this one; every attempt is in `setupFixRunIds`, oldest first.
        setupFixRunId: v.optional(v.id("codingAgentRuns")),
        setupFixRunIds: v.optional(v.array(v.id("codingAgentRuns"))),
        startedAt: v.optional(v.number()),
        status: vCodingAgentRunStatus,
        summary: v.optional(v.string()),
        taskId: v.optional(v.id("tasks")),
        // The task round waiting on this run (`tasks/execute.ts`).
        taskRunId: v.optional(v.id("taskRuns")),
        threadId: v.optional(v.string()),
        toolCallId: v.optional(v.string()),
        updatedAt: v.number(),
        userId: v.string(),
    })
        .shardBy("userId")
        .index("by_user_and_status", ["userId", "status"])
        .index("by_user_and_createdAt", ["userId", "createdAt"])
        .index("by_user_and_toolCallId", ["userId", "toolCallId"])
        .index("by_task_and_createdAt", ["taskId", "createdAt"]),

    connectorDefinitions: defineTable({
        availabilityNote: v.optional(v.string()),
        capabilities: v.array(v.string()),
        category: v.string(),
        description: v.string(),
        docsUrl: v.optional(v.string()),
        icon: v.optional(v.string()),
        isBuiltIn: v.boolean(),
        isPremium: v.boolean(),
        mcpProtocol: v.union(v.literal("sse"), v.literal("http")),
        mcpWorkerUrl: v.string(),
        name: v.string(),
        oauthAuthorizeParams: v.optional(v.array(v.object({ key: v.string(), value: v.string() }))),
        oauthClientEnvPrefix: v.optional(v.string()),
        oauthProvider: v.string(),
        oauthProxyUrl: v.optional(v.string()),
        oauthScopes: v.array(v.string()),
        requiresOAuth: v.boolean(),
        slug: v.string(),
        status: v.union(v.literal("active"), v.literal("beta"), v.literal("deprecated")),
        toolCategories: v.array(v.string()),
    })
        .global()
        .index("by_slug", ["slug"])
        .index("by_category", ["category"])
        .index("by_status", ["status"])
        .searchIndex("search_connectors", { field: "name", filterFields: ["category", "status"] })
        .relations((r) => {
            return {
                userConnectors: r.many("userConnectors", { field: "connectorDefinitionId" }),
            };
        }),
    /**
     * The slot each periodic cron job last ran for (`lib/cron-schedule.ts`,
     * `crons.ts:cronTick`). One row per job name; claiming a slot is what makes
     * a duplicate or late tick run a job at most once per slot. Root shard, like
     * every unsharded table — the tick's mutations run there.
     */
    cronRuns: defineTable({
        lastRunAt: v.number(),
        lastSlot: v.number(),
        name: v.string(),
    }).index("by_name", ["name"]),
    // Per-user scheduling state for the opt-in Daily Brief. See `notifications/daily-brief.ts`.
    dailyBriefState: defineTable({
        lastActiveAt: v.number(),
        lastRunAt: v.optional(v.number()),
        // Local day of the last run, so a delayed or duplicated job runs at most once a morning.
        lastRunLocalDay: v.optional(v.string()),
        scheduledFor: v.optional(v.number()),
        scheduledJobId: v.optional(v.string()),
        userId: v.string(),
    })
        .shardBy("userId")
        .index("by_userId", ["userId"]),
    // One agent-tool call relayed to a paired device (`devices/`), and its audit
    // record. `envelope`/`signature` are what the device verifies; `input` and
    // `output` are capped copies for the activity list. Pruned after 30 days.
    deviceCalls: defineTable({
        claimedAt: v.optional(v.number()),
        // Who holds the claim: the relay window that took it names itself, so its own retry (the answer was lost)
        // is told it still holds it, and another window is not.
        claimId: v.optional(v.string()),
        completedAt: v.optional(v.number()),
        createdAt: v.number(),
        deadline: v.number(),
        // How the device decided: `once`, `always`, `rule`, `denied`, `timeout`.
        decision: v.optional(v.string()),
        deviceId: v.id("devices"),
        deviceName: v.string(),
        envelope: v.string(),
        error: v.optional(v.string()),
        exitCode: v.optional(v.number()),
        input: v.string(),
        output: v.optional(v.string()),
        // Where a `claimed` call is on the device, from its SIGNED progress
        // reports (`reportDeviceCallProgress`): the approval window shows it,
        // then it runs. Only ever moves forward; display only.
        phase: v.optional(vDeviceCallPhase),
        phaseAt: v.optional(v.number()),
        signature: v.string(),
        status: vDeviceCallStatus,
        taintedBy: v.array(vDeviceTaintSource),
        // Absent for the one call no chat starts: the rule-file editor's read of global instruction files
        // (`devices/global-instructions.ts`).
        threadId: v.optional(v.id("threads")),
        // The AI SDK tool call this row answers, so the chat can show its state.
        toolCallId: v.optional(v.string()),
        toolName: v.string(),
        truncated: v.optional(v.boolean()),
        userId: v.string(),
    })
        .shardBy("userId")
        .index("by_deviceId_status", ["deviceId", "status"])
        .index("by_userId_toolCallId", ["userId", "toolCallId"])
        .index("by_userId_createdAt", ["userId", "createdAt"])
        .index("by_status_deadline", ["status", "deadline"])
        .index("by_createdAt", ["createdAt"]),
    /**
     * better-auth `deviceAuthorization` plugin: one row per CLI sign-in code
     * (`auth/cli-device-auth.ts`). Short-lived (30 minutes) and deleted when the
     * code is redeemed, denied, or polled after it expired; issuing a new code
     * also clears the lapsed ones. Hand-maintained like the other auth tables,
     * so `auth.schema.test.ts` checks it. `hostname` is our own column (what the
     * requesting machine calls itself, reduced to host-name characters).
     */
    deviceCode: defineTable({
        clientId: v.optional(v.string()),
        deviceCode: v.string(),
        expiresAt: v.number(),
        hostname: v.optional(v.string()),
        lastPolledAt: v.optional(v.number()),
        // A host code (`neore-host`) also names the machine's platform and where it keeps the device secret.
        platform: v.optional(v.string()),
        pollingInterval: v.optional(v.number()),
        scope: v.optional(v.string()),
        status: v.string(),
        storage: v.optional(v.string()),
        userCode: v.string(),
        userId: v.optional(v.string()),
    })
        .externallyManaged()
        .global()
        .index("deviceCode", ["deviceCode"], { unique: true })
        // The cleanup at every issue deletes the lapsed codes by this column.
        .index("expiresAt", ["expiresAt"])
        .index("userCode", ["userCode"], { unique: true })
        .index("userId", ["userId"]),
    // A pairing code whose device was revoked (`revokeDevice`): `registerHeadlessDevice` refuses it, so a machine
    // still holding the code cannot pair again. On the owner's shard, written in the revoking mutation, so a
    // registration and a revocation of the same code are serialised. Swept after the code can no longer be presented.
    devicePairingRevocations: defineTable({
        codeId: v.string(),
        revokedAt: v.number(),
        userId: v.string(),
    })
        .shardBy("userId")
        .index("by_userId_codeId", ["userId", "codeId"])
        .index("by_revokedAt", ["revokedAt"]),
    // A paired install of the desktop shell (`devices/`, `apps/desktop`). The
    // secret signs calls and verifies results; it is removed on revoke, so a
    // revoked row can sign nothing. `manifest` is the device's verified tools.
    // A server reached over SSH is a row of its own (`transport: "ssh"`) held by
    // the desktop in `viaDeviceId`; only that desktop knows its secret.
    devices: defineTable({
        // The (agent, folder) pairs the user approved for coding agents, from the signed manifest
        // (`updateDeviceManifest`); unset until a shell that knows coding agents has sent one.
        acpOffers: v.optional(v.array(vAcpOffer)),
        // The desktop app's version, as the page relayed it beside the last manifest. Unsigned and display-only.
        appVersion: v.optional(v.string()),
        createdAt: v.number(),
        encryptedSecret: v.optional(v.string()),
        // The wire protocol the computer's signed manifest reported (`MIN_DEVICE_PROTOCOL`); unset until a build that reports it has sent one.
        hostProtocol: v.optional(v.number()),
        lastSeenAt: v.optional(v.number()),
        manifest: v.optional(v.array(vDeviceManifestTool)),
        manifestIssuedAt: v.optional(v.number()),
        name: v.string(),
        // A machine that paired itself by code: the id of the code it redeemed, so a retried registration of the same
        // code (the first reply was lost) finds this device instead of making a second one.
        pairedByCode: v.optional(v.string()),
        platform: vDevicePlatform,
        // Where the device's tools are offered (`devices/lib/scope.ts`): unset = any of the
        // owner's chats, a list = only threads of those projects (empty = nowhere).
        projectIds: v.optional(v.array(v.id("projects"))),
        revokedAt: v.optional(v.number()),
        transport: v.optional(vDeviceTransport),
        userId: v.string(),
        viaDeviceId: v.optional(v.id("devices")),
    })
        .shardBy("userId")
        .index("by_userId", ["userId"]),

    // Ported 1:1 from the audit-history component schema. Read by
    // GDPR (`listUserActivity`, `getDocumentAtTime`) and the canvas version
    // history, so it is a real table rather than a write-only log.
    //
    // `.global()`: entries are keyed by an arbitrary source table's document id,
    // and the GDPR readers scan by user across all of them. Sharding it by
    // `userId` would strand the `by_table_doc_ts` lookup on the wrong shard.
    documentHistory: defineTable({
        attribution: v.optional(v.any()),
        doc: v.any(),
        documentId: v.string(),
        isDeleted: v.boolean(),
        oldDoc: v.optional(v.any()),
        organizationId: v.optional(v.string()),
        tableName: v.string(),
        ts: v.number(),
        userId: v.optional(v.string()),
    })
        .index("by_table_ts", ["tableName", "ts"])
        .index("by_table_doc_ts", ["tableName", "documentId", "ts"])
        .index("by_user_ts", ["userId", "ts"])
        .index("by_org_ts", ["organizationId", "ts"])
        .index("by_ts", ["ts"])
        .global(),

    documents: defineTable({
        content: v.optional(v.string()),
        contentJson: v.optional(v.any()),
        kind: v.union(v.literal("text"), v.literal("code"), v.literal("sheet"), v.literal("image"), v.literal("design")),
        language: v.optional(v.string()),
        messageId: v.optional(v.string()),
        status: v.optional(v.union(v.literal("idle"), v.literal("streaming"))),
        threadId: v.id("threads"),
        title: v.string(),
        userId: v.string(),
        version: v.number(),
    })
        .shardBy("userId")
        .index("by_messageId", ["messageId"])
        .index("by_userId", ["userId"])
        .index("by_threadId_and_kind", ["threadId", "kind"])
        // The image library across all of one user's threads (`media/functions.ts`).
        .index("by_userId_and_kind", ["userId", "kind"])
        .relations((r) => {
            return {
                thread: r.one("threads", { field: "threadId" }),
                versions: r.many("documentVersions", { field: "documentId" }),
            };
        }),

    documentVersions: defineTable({
        commit: v.optional(v.any()),
        content: v.optional(v.string()),
        contentJson: v.optional(v.any()),
        createdAt: v.number(),
        documentId: v.id("documents"),
        userId: v.string(),
        version: v.number(),
    })
        .shardBy("userId")
        .index("by_documentId_version", ["documentId", "version"])
        .relations((r) => {
            return {
                document: r.one("documents", { field: "documentId" }),
            };
        }),

    embeddings_128: defineTable({
        archived: v.optional(v.boolean()),
        model: v.string(),
        model_table_threadId: v.optional(v.string()),
        model_table_userId: v.optional(v.string()),
        table: v.string(),
        threadId: v.optional(v.string()),
        userId: v.optional(v.string()),
        vector: v.array(v.number()),
        // The vector as text: the source `.vectorize()` syncs from (`embed.ts`). Set on every write from `vector`.
        vectorText: v.optional(v.string()),
    })
        .shardBy("userId")
        .index("by_userId", ["userId"])
        .index("model_table_threadId", ["model", "table", "threadId"])
        .vectorize("vectorText", {
            dimensions: 128,
            embed,
            index: "embeddings-128",
            metadata: ["model_table_userId", "model_table_threadId"],
            metric: "cosine",
        }),

    embeddings_256: defineTable({
        archived: v.optional(v.boolean()),
        model: v.string(),
        model_table_threadId: v.optional(v.string()),
        model_table_userId: v.optional(v.string()),
        table: v.string(),
        threadId: v.optional(v.string()),
        userId: v.optional(v.string()),
        vector: v.array(v.number()),
        // The vector as text: the source `.vectorize()` syncs from (`embed.ts`). Set on every write from `vector`.
        vectorText: v.optional(v.string()),
    })
        .shardBy("userId")
        .index("by_userId", ["userId"])
        .index("model_table_threadId", ["model", "table", "threadId"])
        .vectorize("vectorText", {
            dimensions: 256,
            embed,
            index: "embeddings-256",
            metadata: ["model_table_userId", "model_table_threadId"],
            metric: "cosine",
        }),

    embeddings_512: defineTable({
        archived: v.optional(v.boolean()),
        model: v.string(),
        model_table_threadId: v.optional(v.string()),
        model_table_userId: v.optional(v.string()),
        table: v.string(),
        threadId: v.optional(v.string()),
        userId: v.optional(v.string()),
        vector: v.array(v.number()),
        // The vector as text: the source `.vectorize()` syncs from (`embed.ts`). Set on every write from `vector`.
        vectorText: v.optional(v.string()),
    })
        .shardBy("userId")
        .index("by_userId", ["userId"])
        .index("model_table_threadId", ["model", "table", "threadId"])
        .vectorize("vectorText", {
            dimensions: 512,
            embed,
            index: "embeddings-512",
            metadata: ["model_table_userId", "model_table_threadId"],
            metric: "cosine",
        }),

    embeddings_768: defineTable({
        archived: v.optional(v.boolean()),
        model: v.string(),
        model_table_threadId: v.optional(v.string()),
        model_table_userId: v.optional(v.string()),
        table: v.string(),
        threadId: v.optional(v.string()),
        userId: v.optional(v.string()),
        vector: v.array(v.number()),
        // The vector as text: the source `.vectorize()` syncs from (`embed.ts`). Set on every write from `vector`.
        vectorText: v.optional(v.string()),
    })
        .shardBy("userId")
        .index("by_userId", ["userId"])
        .index("model_table_threadId", ["model", "table", "threadId"])
        .vectorize("vectorText", {
            dimensions: 768,
            embed,
            index: "embeddings-768",
            metadata: ["model_table_userId", "model_table_threadId"],
            metric: "cosine",
        }),

    embeddings_1024: defineTable({
        // Thread title/summary vectors only (`agent/thread-search.ts`): whether the thread is archived, for a filter on it.
        archived: v.optional(v.boolean()),
        model: v.string(),
        model_table_threadId: v.optional(v.string()),
        model_table_userId: v.optional(v.string()),
        table: v.string(),
        threadId: v.optional(v.string()),
        userId: v.optional(v.string()),
        vector: v.array(v.number()),
        // The vector as text: the source `.vectorize()` syncs from (`embed.ts`). Set on every write from `vector`.
        vectorText: v.optional(v.string()),
    })
        .shardBy("userId")
        .index("by_userId", ["userId"])
        .index("model_table_threadId", ["model", "table", "threadId"])
        .vectorize("vectorText", {
            dimensions: 1024,
            embed,
            index: "embeddings-1024",
            // `archived` only here: thread vectors live in this table alone (bge-m3, `agent/thread-search-plan.ts`).
            metadata: ["model_table_userId", "model_table_threadId", "archived"],
            metric: "cosine",
        }),

    embeddings_1408: defineTable({
        archived: v.optional(v.boolean()),
        model: v.string(),
        model_table_threadId: v.optional(v.string()),
        model_table_userId: v.optional(v.string()),
        table: v.string(),
        threadId: v.optional(v.string()),
        userId: v.optional(v.string()),
        vector: v.array(v.number()),
        // The vector as text: the source `.vectorize()` syncs from (`embed.ts`). Set on every write from `vector`.
        vectorText: v.optional(v.string()),
    })
        .shardBy("userId")
        .index("by_userId", ["userId"])
        .index("model_table_threadId", ["model", "table", "threadId"])
        .vectorize("vectorText", {
            dimensions: 1408,
            embed,
            index: "embeddings-1408",
            metadata: ["model_table_userId", "model_table_threadId"],
            metric: "cosine",
        }),

    embeddings_1536: defineTable({
        archived: v.optional(v.boolean()),
        model: v.string(),
        model_table_threadId: v.optional(v.string()),
        model_table_userId: v.optional(v.string()),
        table: v.string(),
        threadId: v.optional(v.string()),
        userId: v.optional(v.string()),
        vector: v.array(v.number()),
        // The vector as text: the source `.vectorize()` syncs from (`embed.ts`). Set on every write from `vector`.
        vectorText: v.optional(v.string()),
    })
        .shardBy("userId")
        .index("by_userId", ["userId"])
        .index("model_table_threadId", ["model", "table", "threadId"])
        .vectorize("vectorText", {
            dimensions: 1536,
            embed,
            index: "embeddings-1536",
            metadata: ["model_table_userId", "model_table_threadId"],
            metric: "cosine",
        }),

    // Evals (`evals/`): datasets of cases, runs of a dataset against a target,
    // and one result per case per run. Sharded together — the runner's
    // claim/complete mutations write a run and its results in one transaction.
    evalCases: defineTable({
        checks: v.array(vEvalCheck),
        createdAt: v.number(),
        datasetId: v.id("evalDatasets"),
        expectedAnswer: v.optional(v.string()),
        // Knowledge file NAMES the answer should be retrieved from (RAG datasets).
        expectedSources: v.array(v.string()),
        // A frozen case is a known-bad one kept as a regression check; `deleteCase` refuses it.
        frozen: v.optional(v.boolean()),
        input: v.string(),
        rubric: v.optional(v.string()),
        source: v.union(v.literal("manual"), v.literal("import"), v.literal("chat")),
        updatedAt: v.number(),
        userId: v.string(),
    })
        .shardBy("userId")
        .index("by_dataset_and_createdAt", ["datasetId", "createdAt"])
        .index("by_user", ["userId"]),

    evalDatasets: defineTable({
        caseCount: v.number(),
        createdAt: v.number(),
        description: v.optional(v.string()),
        judgeEnabled: v.boolean(),
        kind: vEvalDatasetKind,
        name: v.string(),
        updatedAt: v.number(),
        userId: v.string(),
    })
        .shardBy("userId")
        .index("by_user_and_updatedAt", ["userId", "updatedAt"]),

    /**
     * One row per case per run (`evals/internal.ts`). `index` is the case's
     * position in the run's snapshot; the claim refuses a second row for the
     * same `(runId, index)`, which is what makes a retried action a no-op.
     */
    evalResults: defineTable({
        answer: v.optional(v.string()),
        caseId: v.id("evalCases"),
        checks: v.array(vEvalCheckResult),
        completedAt: v.optional(v.number()),
        costMicrodollars: v.optional(v.number()),
        error: v.optional(v.string()),
        faithfulness: v.optional(vJudgeVerdict),
        index: v.number(),
        input: v.string(),
        judge: v.optional(vJudgeVerdict),
        latencyMs: v.optional(v.number()),
        passed: v.optional(v.boolean()),
        retrieval: v.optional(vRetrievalMetrics),
        runId: v.id("evalRuns"),
        score: v.optional(v.number()),
        startedAt: v.number(),
        status: vEvalResultStatus,
        threadId: v.optional(v.string()),
        tokens: v.optional(v.number()),
        userId: v.string(),
    })
        .shardBy("userId")
        .index("by_run_and_index", ["runId", "index"])
        .index("by_user", ["userId"]),

    evalRuns: defineTable({
        // The dataset's cases when the run started, in order. Bounded by MAX_CASES_PER_DATASET.
        caseIds: v.array(v.id("evalCases")),
        completedAt: v.optional(v.number()),
        costCapMicrodollars: v.number(),
        costMicrodollars: v.number(),
        createdAt: v.number(),
        datasetId: v.id("evalDatasets"),
        datasetKind: vEvalDatasetKind,
        error: v.optional(v.string()),
        judgeEnabled: v.boolean(),
        label: v.optional(v.string()),
        // The next case index to claim; the run is finished once it reaches `caseIds.length`.
        nextIndex: v.number(),
        // The creator's active organization — server-side, never from args — so a
        // skill shared with it resolves, after re-checking membership.
        organizationId: v.optional(v.string()),
        status: vEvalRunStatus,
        summary: v.optional(vEvalSummary),
        target: vEvalTarget,
        // Budget for the tokens of cases no cost was reported for (`evals/metrics.ts:nextCaseBudget`).
        tokenBudget: v.optional(v.number()),
        unpricedTokens: v.optional(v.number()),
        updatedAt: v.number(),
        userId: v.string(),
    })
        .shardBy("userId")
        .index("by_user_and_status", ["userId", "status"])
        .index("by_dataset_and_createdAt", ["datasetId", "createdAt"]),

    /**
     * What a user sent through "Send feedback": a kind, their text, up to
     * `MAX_FEEDBACK_IMAGES` images (R2 keys under `feedback/<userId>/`) and,
     * when they agreed, the path of the page it was sent from.
     */
    feedback: defineTable({
        createdAt: v.number(),
        images: v.array(v.object({ contentType: v.string(), key: v.string(), size: v.number() })),
        kind: vFeedbackKind,
        message: v.string(),
        pagePath: v.optional(v.string()),
        userId: v.string(),
    })
        // `.global()`, not `.shardBy("userId")`: read across users by the admins.
        .global()
        .index("by_userId", ["userId"])
        // One user's rows oldest first, for the export; the admins read across users by time.
        .index("by_userId_createdAt", ["userId", "createdAt"])
        .index("by_createdAt", ["createdAt"])
        // The admins' list filtered to one kind, so a rare kind does not walk every newer row.
        .index("by_kind_createdAt", ["kind", "createdAt"]),

    files: defineTable({
        chatId: v.optional(v.string()),
        createdAt: v.optional(v.number()),
        folderId: v.optional(v.id("folders")),
        isGenerated: v.optional(v.boolean()),
        key: v.optional(v.string()),
        name: v.string(),
        nsfwScores: v.optional(v.object({ drawing: v.number(), hentai: v.number(), neutral: v.number(), porn: v.number(), sexy: v.number() })),
        nsfwStatus: v.optional(v.union(v.literal("pending"), v.literal("checking"), v.literal("safe"), v.literal("blocked"), v.literal("failed"))),
        organizationId: v.optional(v.string()),
        projectId: v.optional(v.string()),
        size: v.number(),
        tags: v.optional(v.array(v.string())),
        thumbnailStorageId: v.optional(v.string()),
        totalChunks: v.optional(v.number()),
        type: v.string(),
        updatedAt: v.optional(v.number()),
        url: v.optional(v.string()),
        userId: v.string(),
    })
        .shardBy("userId")
        .index("by_user_and_folder", ["userId", "folderId"])
        .index("by_key", ["key"])
        .index("by_chatId", ["chatId"])
        .index("by_user_and_chatId", ["userId", "chatId"])
        .index("by_organization_and_chatId", ["organizationId", "chatId"])
        .index("by_projectId", ["projectId"])
        .index("by_folderId", ["folderId"])
        .relations((r) => {
            return {
                folder: r.one("folders", { field: "folderId" }),
            };
        })
        .triggers((t) => auditTriggersFor(t, "files", AUDIT_TABLES["files"]!)),

    folders: defineTable({
        createdAt: v.number(),
        fileCount: v.optional(v.number()),
        lastSizeUpdate: v.optional(v.number()),
        name: v.string(),
        parentId: v.optional(v.id("folders")),
        totalSize: v.optional(v.number()),
        updatedAt: v.number(),
        userId: v.string(),
    })
        .shardBy("userId")
        .index("by_parent", ["parentId"])
        .index("by_user_and_parent", ["userId", "parentId"])
        .relations((r) => {
            return {
                children: r.many("folders", { field: "parentId" }),
                files: r.many("files", { field: "folderId" }),
                parent: r.one("folders", { field: "parentId" }),
            };
        })
        .triggers((t) => auditTriggersFor(t, "folders", AUDIT_TABLES["folders"]!)),

    followupSuggestions: defineTable({
        // False from the write until the reply's Text unit is taken: an uncharged row is never shown or read as cached. Unset on rows
        // from before this column, which were charged before they were written.
        charged: v.optional(v.boolean()),
        createdAt: v.number(),
        lastMessageId: v.string(),
        // The turn's `order` the suggestions were made for. A write for an older turn is refused, so a slow run cannot replace a newer cache. Unset on rows from before this column.
        order: v.optional(v.number()),
        // When the reply was created: between siblings of one turn, the newer reply's suggestions win. Unset on older rows.
        replyAt: v.optional(v.number()),
        suggestions: v.array(v.string()),
        threadId: v.string(),
        updatedAt: v.number(),
    })
        // One row per reply: a switched branch keeps its own suggestions, so the composer reads the reply on screen by id.
        .index("by_thread", ["threadId"])
        .index("by_thread_and_message", ["threadId", "lastMessageId"]),

    gatewayNotifications: defineTable({
        action: v.string(),
        currentValue: v.number(),
        isRead: v.boolean(),
        metric: v.string(),
        ruleId: v.string(),
        ruleName: v.string(),
        threshold: v.number(),
        triggeredAt: v.number(),
        userId: v.string(),
    })
        .shardBy("userId")
        .index("by_userId_isRead", ["userId", "isRead"]),

    gatewayUsageDeductions: defineTable({
        /**
         * `BillingMode` from `@neore/ai/gateway`; absent on rows from before BYOK
         * billing. Inline because codegen reads columns only as written here;
         * `auth/lib/gateway-credits.ts` pins it to the contract.
         */
        billingMode: v.optional(v.union(v.literal("platform"), v.literal("byok"), v.literal("custom"))),
        /** The call's FULL model cost — for BYOK, `creditsDeducted` is only the fee on it. */
        costMicrodollars: v.number(),
        createdAt: v.number(),
        creditsDeducted: v.number(),
        modelId: v.string(),
        orgId: v.optional(v.string()),
        requestId: v.string(),
        userId: v.string(),
    })
        .shardBy("userId")
        .index("by_requestId", ["requestId"])
        .index("by_userId", ["userId"]),

    gdprAuditLog: defineTable({
        action: v.string(),
        details: v.string(),
        performedBy: v.string(),
        timestamp: v.number(),
        userId: v.string(),
    })
        .shardBy("userId")
        .index("by_user", ["userId"])
        .index("by_action", ["action"])
        .index("by_timestamp", ["timestamp"]),

    gdprConsent: defineTable({
        granted: v.boolean(),
        grantedAt: v.number(),
        purpose: v.string(),
        revokedAt: v.optional(v.number()),
        userId: v.string(),
    })
        .shardBy("userId")
        .index("by_user_and_purpose", ["userId", "purpose"])
        .triggers((t) => auditTriggersFor(t, "gdprConsent", AUDIT_TABLES["gdprConsent"]!)),

    gdprRequests: defineTable({
        completedAt: v.optional(v.number()),
        currentStep: v.optional(v.string()),
        downloadUrl: v.optional(v.string()),
        errorMessage: v.optional(v.string()),
        expiresAt: v.optional(v.number()),
        progress: v.optional(v.number()),
        requestedAt: v.number(),
        requestType: v.union(v.literal("export"), v.literal("deletion"), v.literal("access")),
        status: v.union(v.literal("pending"), v.literal("processing"), v.literal("completed"), v.literal("failed"), v.literal("cancelled")),
        storageId: v.optional(v.string()),
        userEmail: v.string(),
        userId: v.string(),
        workflowId: v.optional(v.string()),
    })
        .shardBy("userId")
        .index("by_user_and_type", ["userId", "requestType"])
        // The deletion check (`usage/gdpr.ts` `deletionUnderwayOnPrimary`) reads one user's requests by type and status, so it finds
        // the blocking ones without reading the rest of the user's request history.
        .index("by_user_type_and_status", ["userId", "requestType", "status"])
        .index("by_expires", ["expiresAt"])
        .index("by_status_and_requestedAt", ["status", "requestedAt"])
        .index("by_status_and_expires", ["status", "expiresAt"]),

    // `tasks/` — a goal is a container with success criteria; its progress is
    // derived from its tasks, never stored.
    goals: defineTable({
        createdAt: v.number(),
        description: v.optional(v.string()),
        status: vGoalStatus,
        successCriteria: v.optional(v.string()),
        title: v.string(),
        updatedAt: v.number(),
        userId: v.string(),
    })
        .shardBy("userId")
        .index("by_user_and_status", ["userId", "status"]),

    /**
     * Claim-once rows (`lib/claim-once.ts`): one per messenger event, trigger
     * webhook delivery or queue job that must happen at most once. `scope` names
     * the kind, `key` the instance. `leaseExpiresAt` is a deadline for the work;
     * past it and uncompleted, `onLapse` runs once. Purged past `expiresAt` by the cron tick;
     * `userId`-tagged rows are erased with the account.
     */
    idempotencyClaims: defineTable({
        claimedAt: v.number(),
        expiresAt: v.number(),
        key: v.string(),
        leaseExpiresAt: v.optional(v.number()),
        // Compensation for a lease that lapses uncompleted (`reapLapsedClaims`).
        onLapse: v.optional(v.object({ args: v.optional(v.string()), target: v.string() })),
        // What the guarded work produced, for a retry to pick up instead of doing it again (a title run's model answer).
        result: v.optional(v.string()),
        scope: v.string(),
        userId: v.optional(v.string()),
    })
        .index("by_scope_key", ["scope", "key"])
        .index("by_expiresAt", ["expiresAt"])
        .index("by_leaseExpiresAt", ["leaseExpiresAt"])
        .index("by_userId", ["userId"]),

    invitation: defineTable({
        // better-auth 1.7.3 writes `createdAt` on every invitation and `teamId`
        // when the invite targets a team (organization `teams.enabled`).
        // Optional only so the schema-drift gate reads it as additive; every
        // row better-auth inserts carries one.
        createdAt: v.optional(v.number()),
        email: v.string(),
        expiresAt: v.number(),
        inviterId: v.string(),
        organizationId: v.string(),
        role: v.optional(v.string()),
        status: v.string(),
        teamId: v.optional(v.string()),
    })
        .externallyManaged()
        .global()
        .index("email_organizationId_status", ["email", "organizationId", "status"])
        .index("organizationId_status", ["organizationId", "status"])
        .index("status", ["status"])
        .triggers((t) => auditTriggersFor(t, "invitation", AUDIT_TABLES["invitation"]!)),

    jwks: defineTable({
        // better-auth 1.7's jwt plugin records the signing algorithm alongside the
        // key pair. Same drift as `account.issuer` — added in a release after this
        // table was written by hand.
        alg: v.optional(v.string()),
        createdAt: v.number(),
        // Key rotation: `getJwks` filters on this plus a grace period.
        crv: v.optional(v.string()),
        expiresAt: v.optional(v.number()),
        privateKey: v.string(),
        publicKey: v.string(),
    })
        .externallyManaged()
        .global(),

    knowledgeChunks: defineTable({
        chunkIndex: v.number(),
        content: v.string(),
        embeddingId: v.optional(v.string()),
        fileId: v.id("knowledgeFiles"),
        metadata: v.optional(v.object({ pageNumber: v.optional(v.number()), sectionHeading: v.optional(v.string()), tableData: v.optional(v.boolean()) })),
        tokenCount: v.optional(v.number()),
        userId: v.string(),
    })
        .shardBy("userId")
        .index("by_fileId_chunkIndex", ["fileId", "chunkIndex"])
        .index("by_embeddingId", ["embeddingId"])
        .index("by_userId", ["userId"])
        // Keyword leg of hybrid retrieval (knowledge/hybrid.ts). FTS5 in the user's shard.
        .searchIndex("search_content", { field: "content", filterFields: ["userId"] }),

    // A thread or project → knowledge collection link (knowledge/collections.ts).
    // Written by the thread's or project's owner, on their shard; the collection
    // itself may be someone else's, shared with their organization.
    knowledgeCollectionLinks: defineTable({
        addedAt: v.number(),
        collectionId: v.id("knowledgeCollections"),
        projectId: v.optional(v.id("projects")),
        threadId: v.optional(v.id("threads")),
        userId: v.string(),
    })
        .shardBy("userId")
        .index("by_threadId", ["threadId"])
        .index("by_projectId", ["projectId"])
        .index("by_collectionId", ["collectionId"])
        .index("by_userId", ["userId"]),

    // A named library of knowledge files. Global so organization members can list
    // and attach a shared one; its files stay on the owner's shard.
    // `organizationId` is set only while shared.
    knowledgeCollections: defineTable({
        createdAt: v.number(),
        description: v.optional(v.string()),
        name: v.string(),
        organizationId: v.optional(v.string()),
        updatedAt: v.number(),
        userId: v.string(),
    })
        .global()
        .index("by_userId", ["userId"])
        .index("by_organizationId", ["organizationId"]),

    knowledgeFiles: defineTable({
        chunkCount: v.optional(v.number()),
        // Unset = uncategorised. Always one of the owner's own collections.
        collectionId: v.optional(v.id("knowledgeCollections")),
        createdAt: v.number(),
        error: v.optional(v.string()),
        mimeType: v.string(),
        name: v.string(),
        organizationId: v.optional(v.string()),
        // Path inside an uploaded folder or a Notion export.
        relativePath: v.optional(v.string()),
        size: v.number(),
        // A web page added by URL; fetched by ingestion.
        sourceUrl: v.optional(v.string()),
        status: v.string(),
        // Object stored for a document added without the vault (knowledge/documents.ts).
        storageKey: v.optional(v.string()),
        summary: v.optional(v.string()),
        updatedAt: v.optional(v.number()),
        userId: v.string(),
        vaultFileId: v.optional(v.id("files")),
    })
        .shardBy("userId")
        .index("by_userId_status", ["userId", "status"])
        .index("by_userId_collectionId", ["userId", "collectionId"])
        .index("by_vaultFileId", ["vaultFileId"]),

    /**
     * The Events log (`public-api/events-log.ts`): one row per run end and approval request, read by `events/poll`. `seq` is
     * one past the user's highest (`mcpEventWatermarks`); `eventId` is stable per upstream event; `data` is the payload as
     * JSON text. Kept seven days (`RETENTION_MS`); every expired row goes, the highest included.
     */
    mcpEvents: defineTable({
        createdAt: v.number(),
        data: v.string(),
        eventId: v.string(),
        name: v.string(),
        seq: v.number(),
        /** The thread the event concerns, as its payload names it: a thread's events are removed with the thread. */
        threadId: v.optional(v.string()),
        timestamp: v.number(),
        userId: v.string(),
    })
        .shardBy("userId")
        .index("by_userId_seq", ["userId", "seq"])
        .index("by_userId_eventId", ["userId", "eventId"])
        .index("by_userId_threadId", ["userId", "threadId"])
        .index("by_createdAt", ["createdAt"]),

    /**
     * The highest `seq` a user's Events log has issued. Kept apart from the rows, so retention can delete every event and the
     * sequence still never restarts. One row per user; removed with the user (`public-api/gdpr.ts`).
     */
    mcpEventWatermarks: defineTable({
        /** The highest seq the retention sweep has expired for this user. A poll reports a gap only behind it: a chat's removal leaves none. */
        prunedThrough: v.optional(v.number()),
        seq: v.number(),
        userId: v.string(),
    })
        .shardBy("userId")
        .index("by_userId", ["userId"]),

    // An OAuth grant for one of the user's own MCP servers
    // (`aiUserPreferences.mcpServers`), keyed by server name AND url: a grant
    // for a server whose URL was since edited is never sent to the new URL.
    // Same token shape as `userConnectors` (`connectors/lib/token-crypto.ts`).
    mcpServerGrants: defineTable({
        accountLabel: v.optional(v.string()),
        connectedAt: v.number(),
        encryptedTokens: v.string(),
        hasRefreshToken: v.boolean(),
        lastError: v.optional(v.string()),
        oauthClient: vOAuthClientRecord,
        scopes: v.array(v.string()),
        serverName: v.string(),
        serverUrl: v.string(),
        status: v.union(v.literal("connected"), v.literal("disconnected"), v.literal("expired"), v.literal("error")),
        tokenExpiresAt: v.optional(v.number()),
        // Authorization-server hosts on ANOTHER site than `serverUrl` that the
        // user explicitly trusted when signing in (`connectors/lib/authorization-server-site.ts`).
        trustedAuthorizationServerHosts: v.optional(v.array(v.string())),
        userId: v.string(),
    })
        .shardBy("userId")
        .index("by_user_and_server", ["userId", "serverName"]),

    member: defineTable({
        createdAt: v.number(),
        organizationId: v.string(),
        role: v.string(),
        userId: v.string(),
    })
        .externallyManaged()
        .global()
        .index("organizationId_userId", ["organizationId", "userId"])
        .index("organizationId_role", ["organizationId", "role"])
        .index("userId", ["userId"])
        .triggers((t) => auditTriggersFor(t, "member", AUDIT_TABLES["member"]!)),

    memberCredits: defineTable({
        creditOverride: v.optional(v.number()),
        memberId: v.string(),
        organizationId: v.string(),
        resetAt: v.optional(v.number()),
        usedCredits: v.optional(v.number()),
        userId: v.string(),
    })
        .global()
        .index("organizationId_userId", ["organizationId", "userId"])
        .index("memberId", ["memberId"])
        .triggers((t) => auditTriggersFor(t, "memberCredits", AUDIT_TABLES["memberCredits"]!)),

    memories: defineTable({
        // Unset = the user's own memory, visible to every chat. Set = the memory of one bot:
        // only that bot reads it, and its extraction never merges into the user's memories.
        botId: v.optional(v.id("bots")),
        confidence: v.optional(v.number()),
        embeddingId: v.optional(v.string()),
        // The day or days the event happens, local `YYYY-MM-DD` (`memory/dates.ts`).
        eventEnd: v.optional(v.string()),
        eventStart: v.optional(v.string()),
        // Where the memory was learned: a short verbatim quote of the user's own words and the message they were in.
        // Replaced whole when newer evidence revises the memory. See `memory/evidence.ts`.
        evidence: v.optional(vMemoryEvidence),
        importance: v.optional(v.number()),
        // The assistant an `imported` memory was brought in from (`memory/import.ts`).
        importedFrom: v.optional(v.union(v.literal("chatgpt"), v.literal("claude"), v.literal("gemini"), v.literal("other"))),
        // Last time evidence confirmed the memory (a restatement, a reflection
        // merge, a user edit). Unset reads as `updatedAt` — see `memory/taxonomy.ts`.
        lastConfirmedAt: v.optional(v.number()),
        memory: v.string(),
        // Pinned by the user: nightly reflection never decays, retires or merges it away.
        pinned: v.optional(v.boolean()),
        source: v.optional(v.union(v.literal("auto"), v.literal("manual"), v.literal("compressed"), v.literal("reflection"), v.literal("imported"))),
        supersededBy: v.optional(v.id("memories")),
        supersedes: v.optional(v.id("memories")),
        threadId: v.optional(v.id("threads")),
        // The taxonomy — see `memory/taxonomy.ts`.
        type: v.union(v.literal("identity"), v.literal("preference"), v.literal("context"), v.literal("activity"), v.literal("experience")),
        updatedAt: v.optional(v.number()),
        userId: v.optional(v.string()),
        // Last local day the fact holds; after it the memory is not injected and reflection retires it.
        validUntil: v.optional(v.string()),
        version: v.optional(v.number()),
    })
        .shardBy("userId")
        .index("threadId", ["threadId"])
        .index("embeddingId", ["embeddingId"])
        .index("by_userId_type", ["userId", "type"])
        .index("by_userId_supersededBy", ["userId", "supersededBy"])
        // A scope's rows read directly: the user's own (`botId` null) or one bot's. `type` keeps
        // the type-first order the old by_userId_type read had, so a window still keeps preferences.
        .index("by_userId_botId", ["userId", "botId", "type"])
        // The same scope, active rows only: superseded history never enters a read. `supersededBy` is null for an active row.
        .index("by_userId_botId_active", ["userId", "botId", "supersededBy", "type"]),

    // One nightly-reflection digest ("what I learned today") per run. See `memory/reflection.ts`.
    memoryDigests: defineTable({
        createdAt: v.number(),
        dismissedAt: v.optional(v.number()),
        // Memories learned or changed that day, as they read at digest time.
        learned: v.array(v.object({ memory: v.string(), memoryId: v.string(), type: v.string() })),
        // Local calendar day (`YYYY-MM-DD`, the user's timezone) the digest covers.
        localDay: v.string(),
        stats: v.object({
            contradictionsResolved: v.number(),
            decayed: v.number(),
            merged: v.number(),
            newMemories: v.number(),
            promoted: v.number(),
            retired: v.number(),
        }),
        summary: v.string(),
        userId: v.string(),
    })
        .shardBy("userId")
        .index("by_userId_createdAt", ["userId", "createdAt"]),

    // The parsed, redacted entries of one job's batch. Never the raw file; deleted when the job ends.
    memoryImportBatches: defineTable({
        entries: v.array(
            v.object({
                memory: v.string(),
                type: v.union(v.literal("identity"), v.literal("preference"), v.literal("context"), v.literal("activity"), v.literal("experience")),
            }),
        ),
        index: v.number(),
        jobId: v.id("memoryImportJobs"),
        userId: v.string(),
    })
        .shardBy("userId")
        .index("by_jobId_index", ["jobId", "index"])
        .index("by_userId", ["userId"]),

    // One background import of a large memory file. The job reads its parsed entries from `memoryImportBatches`, one
    // batch per queue message, and drops them when it ends. See `memory/import-job.ts`.
    memoryImportJobs: defineTable({
        batchCount: v.number(),
        // The batch a delivery claimed, so a redelivery of the same batch finds the claim taken.
        claimedBatch: v.optional(v.number()),
        createdAt: v.number(),
        done: v.number(),
        duplicates: v.number(),
        error: v.optional(v.string()),
        imported: v.number(),
        invalid: v.number(),
        // The batch that runs next; only that batch may be claimed.
        nextBatch: v.number(),
        status: v.union(v.literal("preparing"), v.literal("queued"), v.literal("running"), v.literal("done"), v.literal("failed")),
        tooLong: v.number(),
        // Entries read from the file: kept, duplicate, too long and invalid.
        total: v.number(),
        updated: v.number(),
        updatedAt: v.number(),
        userId: v.string(),
    })
        .shardBy("userId")
        .index("by_userId_createdAt", ["userId", "createdAt"]),

    // Per-user scheduling state for nightly reflection. See `memory/reflection.ts`.
    memoryReflectionState: defineTable({
        lastActiveAt: v.number(),
        lastRunAt: v.optional(v.number()),
        // Local day of the last run, so a delayed or duplicated job runs at most once a night.
        lastRunLocalDay: v.optional(v.string()),
        scheduledFor: v.optional(v.number()),
        scheduledJobId: v.optional(v.string()),
        userId: v.string(),
    })
        .shardBy("userId")
        .index("by_userId", ["userId"]),

    messages: defineTable({
        agentName: v.optional(v.string()),
        // Display time in ms (an imported message keeps its source time). Never an ordering
        // key: rows are ordered by (order, stepOrder). Unset on rows from before this column.
        createdAt: v.optional(v.number()),
        embeddingId: v.optional(v.string()),
        error: v.optional(v.string()),
        fileIds: v.optional(v.array(v.id("chatFiles"))),
        finishReason: v.optional(v.string()),
        // Whether the run that wrote this row ran on the device, stamped when the run finishes (`agent/followup-suggestions.ts`).
        // Unset on rows from before the stamp, which fall back to the endpoint's current type.
        localRun: v.optional(v.boolean()),
        message: v.optional(v.any()),
        model: v.optional(v.string()),
        order: v.number(),
        // In-thread branching (regenerate / edit alternatives). Set only on a row
        // whose parent is NOT the row just before it in (order, stepOrder) —
        // `"root"` for a top-level sibling. Unset means "the previous row", which
        // is how every row written before branching existed reads as one line.
        // See `agent/branch-tree.ts`.
        parentMessageId: v.optional(v.string()),
        provider: v.optional(v.string()),
        providerMetadata: v.optional(v.any()),
        providerOptions: v.optional(v.any()),
        reasoning: v.optional(v.string()),
        reasoningDetails: v.optional(v.any()),
        // The run that wrote the row (its stream id). Every row of one reply shares it, so a call keeps its identity
        // when the reply's rows are merged, and a regenerated or group reply, which has its own run, is told apart.
        replyId: v.optional(v.string()),
        // Memories injected into the system prompt for this reply — the "why was
        // this used" view (`memory/functions.ts#getMessageMemoryUsage`).
        retrievedMemories: v.optional(v.array(v.object({ memoryId: v.string(), score: v.number() }))),
        sources: v.optional(v.any()),
        // Group chat: the participant (skill id) that wrote this row. `agentName`
        // holds its display name. See `chat/group/`.
        speakerSkillId: v.optional(v.string()),
        status: v.string(),
        stepOrder: v.number(),
        text: v.optional(v.string()),
        threadId: v.id("threads"),
        tool: v.boolean(),
        // What the person typed into a user message (`agent/shared.ts#typedTextColumn`: no attachment, quote or placeholder),
        // written beside `text` on insert, edit and rewrite. Only the composer's prompt search reads it, through
        // `typed_text_search`; `text` stays the message as it was sent. Unset on every other row.
        typedText: v.optional(v.string()),
        usage: v.optional(
            v.object({
                cachedInputTokens: v.optional(v.number()),
                cacheReadTokens: v.optional(v.number()),
                cacheWriteTokens: v.optional(v.number()),
                completionTokens: v.optional(v.number()),
                durationMs: v.optional(v.number()),
                promptTokens: v.optional(v.number()),
                reasoningTokens: v.optional(v.number()),
                totalTokens: v.optional(v.number()),
                ttftMs: v.optional(v.number()),
            }),
        ),
        userId: v.optional(v.string()),
        warnings: v.optional(v.any()),
    })
        .shardBy("userId")
        .index("threadId_status_tool_order_stepOrder", ["threadId", "status", "tool", "order", "stepOrder"])
        .index("by_threadId_order_stepOrder", ["threadId", "order", "stepOrder"])
        // Explicit branch children (`agent/branch-rows.ts`), so a branched
        // thread's path and siblings resolve without loading the whole thread.
        .index("by_threadId_parentMessageId", ["threadId", "parentMessageId"])
        .index("embeddingId_threadId", ["embeddingId", "threadId"])
        .searchIndex("text_search", { field: "text", filterFields: ["userId", "threadId"] })
        .searchIndex("typed_text_search", { field: "typedText", filterFields: ["userId"] })
        // A deleted user turn can drop its thread below the palette search's turn gate (`agent/thread-search-triggers.ts`).
        .triggers((t) => threadSearchMessageTriggers(t))
        .relations((r) => {
            return {
                thread: r.one("threads", { field: "threadId" }),
            };
        }),

    messengerConnections: defineTable({
        connectedAt: v.number(),
        displayName: v.optional(v.string()),
        lastMessageAt: v.optional(v.number()),
        metadata: v.optional(v.any()),
        pairingCodeExpiresAt: v.optional(v.number()),
        /** SHA-256 of the one-time `/pair` code (`messenger/lib/pairing.ts`); never the code itself. */
        pairingCodeHash: v.optional(v.string()),
        platform: v.union(
            v.literal("telegram"),
            v.literal("slack"),
            v.literal("discord"),
            v.literal("whatsapp"),
            v.literal("line"),
            v.literal("feishu"),
            v.literal("teams"),
            v.literal("wechat"),
        ),
        platformChatId: v.optional(v.string()),
        platformUserId: v.optional(v.string()),
        platformUsername: v.optional(v.string()),
        /**
         * Tools for this connection's replies (`messenger/lib/reply-tools.ts`).
         * Absent = off. `groups` absent = every group; unknown names are ignored.
         */
        replyTools: v.optional(v.object({ enabled: v.boolean(), groups: v.optional(v.array(v.string())) })),
        status: v.union(v.literal("active"), v.literal("paused"), v.literal("disconnected")),
        userId: v.string(),
    })
        .shardBy("userId")
        .index("by_user_and_platform", ["userId", "platform"])
        .index("by_platform_and_chatId", ["platform", "platformChatId"])
        .index("by_platform_and_userId", ["platform", "platformUserId"])
        .index("by_status", ["status"]),

    nodeExecutions: defineTable({
        completedAt: v.optional(v.number()),
        error: v.optional(v.string()),
        executionId: v.id("workflowExecutions"),
        input: v.optional(v.any()),
        nodeId: v.string(),
        nodeType: v.string(),
        output: v.optional(v.any()),
        startedAt: v.optional(v.number()),
        status: v.union(v.literal("pending"), v.literal("running"), v.literal("completed"), v.literal("failed"), v.literal("skipped")),
        usage: v.optional(v.object({ completionTokens: v.number(), promptTokens: v.number(), totalTokens: v.number() })),
    }).index("by_execution_and_node", ["executionId", "nodeId"]),
    // The notification inbox (`notifications/`): one row per event for its
    // user, written only through `notify()`. `title` is the SUBJECT (a task's
    // title); the UI words what happened from `type` + `outcome`. Pruned after
    // 30 days by the housekeeping sweep.
    notifications: defineTable({
        ...notificationInputFields,
        createdAt: v.number(),
        readAt: v.optional(v.number()),
    })
        .shardBy("userId")
        .index("by_userId_createdAt", ["userId", "createdAt"])
        .index("by_userId_readAt_createdAt", ["userId", "readAt", "createdAt"])
        .index("by_userId_dedupeKey", ["userId", "dedupeKey"])
        .index("by_createdAt", ["createdAt"]),
    // One open connector OAuth flow. `state` is the SHA-256 of the value sent to
    // the provider; `flow` carries what completion needs (PKCE verifier and any
    // DCR client secret encrypted). Single-use: completion deletes the row.
    oauthStates: defineTable({
        // RFC 9207: the server advertised `iss` on its responses, so the callback refuses one without it.
        authorizationResponseIssParameterSupported: v.optional(v.boolean()),
        // Legacy target encoding (a slug, or `mcp:<name>` plus `mcpServer`), read
        // only for rows written before `target`; new rows carry `target` alone.
        connectorSlug: v.optional(v.string()),
        expiresAt: v.number(),
        flow: v.optional(vOAuthFlow),
        mcpServer: v.optional(v.object({ name: v.string(), url: v.string() })),
        state: v.string(),
        target: v.optional(vOAuthTarget),
        userId: v.string(),
    })
        .shardBy("userId")
        .index("by_state", ["state"])
        .index("by_expiresAt", ["expiresAt"])
        .index("by_userId", ["userId"]),

    organization: defineTable({
        allowedModels: v.optional(v.array(v.string())),
        baseTier: v.optional(v.union(v.literal("free"), v.literal("pro"), v.literal("enterprise"))),
        billingEmail: v.optional(v.string()),
        createdAt: v.number(),
        creditsPerUser: v.optional(v.number()),
        /** Set by the Creem webhook for the organization's Team subscription; the portal opens on it. */
        creemCustomerId: v.optional(v.string()),
        /**
         * The owner who PAID for Team, written by the webhook with `creemCustomerId`
         * (from the checkout's metadata). Creem keys a customer by email, so
         * `creemCustomerId` is that person's own Creem customer (their personal Pro,
         * invoices, payment method); only they may open the portal on it.
         */
        creemPurchaserId: v.optional(v.string()),
        /** The Creem subscription that set `baseTier`; a cancel of any other one leaves the tier alone. */
        creemSubscriptionId: v.optional(v.string()),
        logo: v.optional(v.string()),
        metadata: v.optional(v.string()),
        monthlyCredits: v.optional(v.number()),
        name: v.string(),
        ownerId: v.optional(v.string()),
        slug: v.optional(v.string()),
    })
        .externallyManaged()
        .global()
        // The Team plans a user pays for (account deletion cancels them; the
        // delete-account dialog warns about them), found even after the payer
        // left the organization.
        .index("creemPurchaserId", ["creemPurchaserId"])
        .index("name", ["name"])
        .index("slug", ["slug"])
        .triggers((t) => auditTriggersFor(t, "organization", AUDIT_TABLES["organization"]!)),

    organizationPolicies: defineTable({
        // The policy as canonical JSON text, written only after `auth/lib/organization-policy.ts`
        // accepted it. Text, not a typed object, so the parser stays the one place that knows its shape.
        document: v.string(),
        organizationId: v.string(),
        // Moves on every write, so a reader can tell a newer policy from the one it holds.
        revision: v.number(),
        schemaVersion: v.number(),
        updatedAt: v.number(),
    })
        .global()
        .index("organizationId", ["organizationId"])
        .triggers((t) => auditTriggersFor(t, "organizationPolicies", AUDIT_TABLES["organizationPolicies"]!)),

    // The outbox for opt-in task-outcome mail (`notifications/task-email.ts`): written
    // in `notify()`'s own transaction, one row per inbox row, sent by the housekeeping
    // sweep. Sent rows are pruned after 7 days; failed ones (attempt cap) likewise.
    outcomeEmails: defineTable({
        attempts: v.number(),
        /** When a send run took the row. A claim older than the recovery window is abandoned. */
        claimedAt: v.optional(v.number()),
        createdAt: v.number(),
        link: v.string(),
        notificationId: v.id("notifications"),
        sentAt: v.optional(v.number()),
        status: v.union(v.literal("pending"), v.literal("sending"), v.literal("sent"), v.literal("failed")),
        title: v.string(),
        userId: v.string(),
    })
        .shardBy("userId")
        .index("by_status_createdAt", ["status", "createdAt"])
        .index("by_notificationId", ["notificationId"])
        .index("by_userId", ["userId"]),

    // Pages workspace (`pages/`). A grant: `userId` is the GRANTEE, `ownerId`
    // the page owner — so a grantee's "shared with me" list is one index read.
    pageAccess: defineTable({
        /** Set while the GRANTEE has starred the page — a shared page's star lives on the grant, which their sidebar reads from their own shard. */
        favoritedAt: v.optional(v.number()),
        grantedAt: v.number(),
        grantedBy: v.string(),
        /** The page's icon and title, copied here so the grantee's sidebar can list a shared page without reading the owner's shard. */
        icon: v.optional(v.string()),
        ownerId: v.string(),
        pageId: v.id("pages"),
        permission: v.union(v.literal("read"), v.literal("comment"), v.literal("write"), v.literal("admin")),
        title: v.optional(v.string()),
        userId: v.string(),
    })
        // `.global()`, not `.shardBy("userId")`: read across users.
        .global()
        .index("by_page_and_user", ["pageId", "userId"])
        .index("by_user_and_owner", ["userId", "ownerId"]),

    // A root comment carries `commentId` (the anchor mark's id) and `anchorText`;
    // a reply carries `parentId` and neither. `userId` is the AUTHOR.
    pageComments: defineTable({
        anchorText: v.optional(v.string()),
        authorName: v.string(),
        body: v.string(),
        commentId: v.string(),
        createdAt: v.number(),
        editedAt: v.optional(v.number()),
        orphaned: v.optional(v.boolean()),
        pageId: v.id("pages"),
        parentId: v.optional(v.id("pageComments")),
        resolvedAt: v.optional(v.number()),
        resolvedBy: v.optional(v.string()),
        status: v.union(v.literal("open"), v.literal("resolved")),
        userId: v.string(),
    })
        .shardBy("userId")
        .index("by_page_and_created", ["pageId", "createdAt"])
        .index("by_user", ["userId"]),

    // Link invites: the plaintext token is never stored, only its SHA-256.
    // Per-user favorites, so a collaborator can star a page shared with them.
    pageFavorites: defineTable({
        createdAt: v.number(),
        pageId: v.id("pages"),
        userId: v.string(),
    })
        .shardBy("userId")
        .index("by_user_and_page", ["userId", "pageId"])
        .index("by_page", ["pageId"]),

    pageInvites: defineTable({
        acceptedAt: v.optional(v.number()),
        acceptedBy: v.optional(v.string()),
        createdAt: v.number(),
        expiresAt: v.number(),
        /** The page's owner, so a token redeemed from the invitee's shard leads to the page's. */
        ownerId: v.optional(v.string()),
        pageId: v.id("pages"),
        permission: v.union(v.literal("read"), v.literal("comment"), v.literal("write"), v.literal("admin")),
        status: v.union(v.literal("pending"), v.literal("accepted"), v.literal("revoked")),
        tokenHash: v.string(),
        userId: v.string(),
    })
        // `.global()`, not `.shardBy("userId")`: read across users.
        .global()
        .index("by_tokenHash", ["tokenHash"])
        .index("by_page", ["pageId"]),

    pagePresence: defineTable({
        isEditing: v.boolean(),
        lastHeartbeat: v.number(),
        pageId: v.id("pages"),
        sessionId: v.string(),
        userColor: v.string(),
        userId: v.string(),
        userName: v.string(),
    })
        .shardBy("userId")
        .index("by_page", ["pageId"])
        .index("by_session", ["sessionId"])
        .index("by_user", ["userId"]),

    pages: defineTable({
        content: v.optional(v.string()),
        contentJson: v.optional(v.any()),
        // The revision of the last write that changed more than comment marks.
        // A save based on an older revision is a conflict only if this moved
        // past it (`logic.ts#isRevisionConflict`).
        contentRevision: v.number(),
        createdAt: v.number(),
        icon: v.optional(v.string()),
        isPublic: v.optional(v.boolean()),
        lastEditedBy: v.optional(v.string()),
        order: v.number(),
        parentPageId: v.optional(v.id("pages")),
        publicAccessToken: v.optional(v.string()),
        // Bumped by EVERY content write, comment marks included — the optimistic-concurrency token.
        revision: v.number(),
        searchText: v.optional(v.string()),
        sourceDocumentId: v.optional(v.string()),
        title: v.string(),
        updatedAt: v.number(),
        userId: v.string(),
    })
        .shardBy("userId")
        .index("by_user", ["userId"])
        .index("by_parent", ["parentPageId"])
        .index("by_publicAccessToken", ["publicAccessToken"]),

    pageVersions: defineTable({
        content: v.optional(v.string()),
        contentJson: v.optional(v.any()),
        createdAt: v.number(),
        pageId: v.id("pages"),
        reason: v.union(v.literal("edit"), v.literal("agent"), v.literal("restore")),
        title: v.string(),
        updatedAt: v.number(),
        userId: v.string(),
    })
        .shardBy("userId")
        .index("by_page_and_created", ["pageId", "createdAt"])
        .index("by_user", ["userId"]),

    /**
     * better-auth `passkey` plugin (WebAuthn credentials). Hand-maintained like
     * the other auth tables — `auth.schema.test.ts` checks it against the
     * plugin. `name`, `transports`, `createdAt` and `aaguid` are optional
     * because the plugin does not always write them.
     */
    passkey: defineTable({
        aaguid: v.optional(v.string()),
        backedUp: v.boolean(),
        counter: v.number(),
        createdAt: v.optional(v.number()),
        credentialID: v.string(),
        deviceType: v.string(),
        name: v.optional(v.string()),
        publicKey: v.string(),
        transports: v.optional(v.string()),
        userId: v.string(),
    })
        .externallyManaged()
        .global()
        .index("userId", ["userId"])
        .index("credentialID", ["credentialID"])
        .triggers((t) => auditTriggersFor(t, "passkey", AUDIT_TABLES["passkey"]!)),

    persistentChunks: defineTable({
        // A host stream's event that carries no text (a tool call, a permission request, the end of the
        // turn). It still takes its `seq`, so the host's `(turnId, seq)` claim covers every event.
        event: v.optional(vHostEvent),
        reasoning: v.optional(v.string()),
        // Steering (`chat/steering.ts`): the reply continues below a message the
        // user sent into it. The text before this chunk is a saved message by
        // now, so readers show only what follows, as for a `speaker` marker.
        restart: v.optional(v.boolean()),
        // The chunk's position in its stream, 0-based, stamped by `addChunk`
        // as one past the stream's last chunk. Lets a poll read only the chunks
        // past its cursor (`by_streamId_seq`). Kept off `persistentStreams` so a
        // chunk write never touches the row a live query reads.
        seq: v.number(),
        // Group chat: marks where the next participant starts speaking. Every
        // chunk after it, up to the next marker, is that participant's.
        speaker: v.optional(v.object({ name: v.string(), skillId: v.string() })),
        streamId: v.id("persistentStreams"),
        text: v.string(),
        // A long MCP tool call's latest progress report (`chat/lib/mcp-progress.ts`), or `ended` once the
        // call is over. The chunk carries no text: the placeholder keeps the newest per `toolCallId`.
        toolProgress: v.optional(
            v.object({
                ended: v.optional(v.boolean()),
                message: v.optional(v.string().max(500)),
                progress: v.optional(v.number()),
                serverName: v.string().max(500),
                toolCallId: v.string().max(128),
                toolName: v.string().max(500),
                total: v.optional(v.number()),
            }),
        ),
    })
        .index("by_streamId_seq", ["streamId", "seq"])
        .relations((r) => {
            return {
                stream: r.one("persistentStreams", { field: "streamId" }),
            };
        }),

    persistentStreams: defineTable({
        // Liveness of the run writing this stream: set when it registers (`registerResumableRun`), then every ~minute
        // while it lives and by each resume's claim. A stale beat on a claimed, unpaused stream is a dead worker.
        beatAt: v.optional(v.number()),
        // The turn's prompt carried a handoff; `turn_start` is the proof the agent received it (`acpSessions.handoffSentAt`).
        carriesHandoff: v.optional(v.boolean()),
        // The steps whose pause "Retry now" cut short (`retryPausedRunsNow`): the provider's limit may not have lifted, so
        // such a step may pause once more. It still counts toward the cap on pauses.
        earlySteps: v.optional(v.array(v.string())),
        expiresAt: v.number(),
        // Host-run turns (`acp/`; unset = a cloud turn). `hostTurnId` is the UUID the starter minted;
        // `hostState` drives "Sending" versus "Working"; the permission ids are the requests the agent is
        // waiting on, which keep the reaper off the stream.
        hostEndReason: v.optional(vHostEndReason),
        hostPendingPermissions: v.optional(v.array(v.string())),
        // A regenerate: the reply is saved beside the earlier one, as a sibling (`acp/lib/finish.ts`). Nothing sets it
        // yet: only the tests do, until S4's remote send starts a regenerate.
        hostRegenerate: v.optional(v.boolean()),
        hostState: v.optional(vHostState),
        hostTurnId: v.optional(v.string()),
        // How many times the run was resumed after its worker died (`interrupted.ts`); capped, the next one fails the run.
        interruptions: v.optional(v.number()),
        messageId: v.string(),
        // The steers above holding text the run's user did not type (`lib/not-typed-text.ts`), by id: the row they are
        // delivered as, and the run's message, carry the mark. At most one per steer (`MAX_STEERS_PER_RUN`).
        notTypedSteers: v.optional(v.array(v.object({ id: v.string(), notTyped: vNotTypedMarks }))),
        // The run is waiting out a provider rate limit (`chat/lib/rate-limit-pause.ts`). The stream stays live
        // (pending/streaming) so a stop, the live query and the expiry sweep treat it as the run it is; `id`
        // names this pause, and exactly one resume claims it (`claimRunResume`). `run` is the job's own
        // input, kept so "Retry now" can enqueue the resume from a mutation.
        pause: v.optional(
            v.object({
                // The row the rejected step continues from: the last row this run saved, else the prompt.
                // The resume streams from it as its prompt, so it lands under it and not beside it.
                from: v.string(),
                id: v.string(),
                provider: v.optional(v.string()),
                reason: v.literal("rate_limit"),
                retryAt: v.number(),
                run: v.object({ ...runStreamingAgentFields }),
                status: v.number(),
            }),
        ),
        // The person resumes the paused run (`resumeAfterUsageLimit` is off): no resume is queued, and "Retry now" resumes it once the reset has
        // passed. Set and cleared with `pause`; a top-level field, not a change to the `pause` object, so stored pauses keep their shape.
        pauseAwaitsPerson: v.optional(v.literal(true)),
        // What the run has done before its pauses, cumulative across them: the reply rows it saved, how many steps
        // it ran (the resume gets only the rest of the step cap), and what its usage record needs (`skill`,
        // `timeZone`). The run records ONE reply when it ends, covering these rows; a pause that never resumes
        // (a stop, a superseded run) records them itself (`pause-usage.ts`), once, and clears this.
        // Set with `pause` when the pause is the resume of a run whose worker died, not a rate-limit wait
        // (`streaming/persistent/interrupted.ts`); `pause.reason` keeps its one stored value, since widening it
        // reads as a breaking schema change.
        pauseCause: v.optional(v.literal("interrupted")),
        pausedRun: v.optional(
            v.object({
                replyRowIds: v.array(v.string()),
                skill: v.optional(v.object({ id: v.optional(v.string()), name: v.string() })),
                stepsUsed: v.number(),
                timeZone: v.optional(v.string()),
            }),
        ),
        // The rows a run paused on, one per pause (`rate-limit-pause.ts#planPause`): a step is paused on once, a run three times.
        pausedSteps: v.optional(v.array(v.string())),
        // The provider gave no reset time, so the pause's `retryAt` is the default wait, not a reset (`pauseRunForRateLimit`).
        pauseResetUnreported: v.optional(v.literal(true)),
        // The snooze a rate-limit pause put on its chat (`pauseRunForRateLimit`): the reset time it set, and the value it replaced
        // (absent if none), so lifting it restores the owner's own snooze.
        pauseSnooze: v.optional(v.object({ previousUntil: v.optional(v.number()), until: v.number() })),
        producer: v.optional(v.literal("host")),
        // What the reply's usage record needs, kept from the run's start (`registerResumableRun`) for a run that dies before
        // any pause stored it in `pausedRun`.
        replyContext: v.optional(v.object({ skill: v.optional(v.object({ id: v.optional(v.string()), name: v.string() })), timeZone: v.optional(v.string()) })),
        // Whether the person lets a dead run resume (`userSettings.resumeInterruptedRuns`), decided by the run's own action
        // (the setting lives on the person's shard, the stream may sit on a thread owner's). Absent = on.
        resumable: v.optional(v.boolean()),
        // The job's own arguments, stored by a run that may be resumed when its worker dies (`registerResumableRun`).
        // Absent: tool-approval continuations, group turns and stateless runs, which are never resumed that way.
        runArgs: v.optional(v.object({ ...runStreamingAgentFields })),
        // Set once, by the ONE run that may write this stream (`claimStreamRun`).
        // The run arrives on the jobs queue, which delivers at least once; a
        // redelivery finds this set and does nothing.
        runClaimedAt: v.optional(v.number()),
        // Which run holds this stream: absent for the first claim, one more for each resume claim (`claimRunResume`). A run
        // carries its number on every write that matters and is refused once a newer run holds the stream (`run-epoch.ts`).
        runEpoch: v.optional(v.number()),
        status: v.string(),
        // Messages the run's user sent into it while it streams (`chat/steering.ts`).
        // `queued` until the run takes them at a step boundary; a delivered entry
        // keeps only its id, so the client can tell delivery from withdrawal. `withdrawn`
        // marks an id closed before the run held it, so a late `steerRun` queues nothing.
        steers: v.optional(
            v.array(
                v.object({
                    id: v.string(),
                    /** Set on delivery: the steered message's row, which a stopped run's owed text follows. */
                    messageId: v.optional(v.string()),
                    /** Set on delivery: the run's pending row, moved under that message, so a stop finds it even when that message is gone. */
                    pendingMessageId: v.optional(v.string()),
                    /**
                     * When the user sent it: memory reads "tomorrow" in it against that day, not the delivery's, and a memory
                     * quoting it is dated by it. Kept on delivery, so a recovered reply dates its steers.
                     */
                    sentAt: v.optional(v.number()),
                    status: v.union(v.literal("queued"), v.literal("delivered"), v.literal("withdrawn")),
                    text: v.optional(v.string()),
                    /** Set on delivery: the length of the text, so a recovered reply can split the combined row into its steers. */
                    textLength: v.optional(v.number()),
                }),
            ),
        ),
        // Set by the sidebar's stop, cleared once the run has saved the text it still owed (`finishStoppedReply`).
        // While set the stream is `done` but its reply is not in the thread yet, so an agent switch waits (`hasUnsettledStop`).
        stoppedAt: v.optional(v.number()),
        streamingConfig: v.object({
            contentType: v.string(),
            customSystemPrompt: v.optional(v.string()),
            enabledFeatures: v.optional(v.array(v.string())),
            imageSize: v.optional(v.string()),
            model: v.string(),
            reasoningEffort: v.optional(v.number()),
            researchDepth: v.optional(v.union(v.literal("speed"), v.literal("balanced"), v.literal("thorough"))),
            searchMode: v.optional(v.string()),
            statelessMode: v.optional(v.boolean()),
        }),
        threadId: v.string(),
        // The real server and tool names of the run's MCP tools (`McpToolLabels`), kept so a reply recovered after its
        // worker died is stamped like one that finished (`registerResumableRun`, `recoverFinishedReply`).
        toolLabels: v.optional(v.record(v.string(), v.object({ serverName: v.string(), toolName: v.string() }))),
        // Tool calls started and not yet finished (`markToolRun`). A worker that dies with one open may have paid for or
        // changed something, so such a run is never resumed.
        toolsInFlight: v.optional(v.number()),
        userId: v.string(),
    })
        .shardBy("userId")
        .index("by_status", ["status"])
        .index("by_expiresAt", ["expiresAt"])
        .index("by_userId_status", ["userId", "status"])
        .index("by_threadId", ["threadId"])
        .index("by_threadId_messageId", ["threadId", "messageId"])
        .index("by_threadId_status", ["threadId", "status"])
        .index("by_hostTurnId", ["hostTurnId"])
        .relations((r) => {
            return {
                chunks: r.many("persistentChunks", { field: "streamId" }),
            };
        }),

    // One row per account that writes pins: the latest time a pin write of the account may still be in flight. A move waits for it
    // to pass before it sweeps the account's pins (`lib/account-moves.ts`).
    pinWriteLeases: defineTable({
        expiresAt: v.number(),
        userId: v.string(),
    })
        .global()
        .index("by_user", ["userId"]),

    playgroundApiKeys: defineTable({
        name: v.optional(v.string()),
    }).index("name", ["name"]),

    presentations: defineTable({
        createdAt: v.number(),
        description: v.optional(v.string()),
        lastCompletedSlide: v.optional(v.number()),
        name: v.string(),
        status: v.optional(v.string()),
        styleName: v.optional(v.string()),
        threadId: v.id("threads"),
        title: v.string(),
        totalSlides: v.optional(v.number()),
        updatedAt: v.number(),
        userId: v.string(),
    })
        .shardBy("userId")
        .index("by_user_and_thread", ["userId", "threadId"])
        .index("by_thread_and_status", ["threadId", "status"]),

    presentationSlides: defineTable({
        createdAt: v.number(),
        htmlContent: v.string(),
        presentationId: v.id("presentations"),
        slideNumber: v.number(),
        title: v.string(),
        updatedAt: v.number(),
    }).index("by_presentation_and_number", ["presentationId", "slideNumber"]),

    projectKnowledge: defineTable({
        assignedAt: v.number(),
        knowledgeFileId: v.id("knowledgeFiles"),
        projectId: v.id("projects"),
    })
        .index("by_projectId", ["projectId"])
        .index("by_knowledgeFileId", ["knowledgeFileId"]),

    // The repositories a coding-agent run in a project picks from (`projects/repositories.ts`), one row each, so a
    // change to one never rewrites another or the project. Global, like `projects`: a member reads them from
    // their own shard. `url` is in `parseRepoUrl` clone form; the default is the row with the latest `defaultAt`. A row
    // with the URL "#default" is not a repository either: it holds the project's last `defaultAt` stamp, so each pick
    // claims the next one (`stampDefault`).
    // `userId` and `organizationId` copy the project's, so account deletion and export reach a row by its owner and a
    // URL lookup stays inside the caller's own and organization's rows. A row with `deletingAt` (and the URL "") is
    // not a repository: it marks a project delete in progress (`deleteProject`).
    projectRepositories: defineTable({
        // Moves on every default-branch save; a save naming an older one is refused (`updateProjectRepo`).
        branchRevision: v.optional(v.number()),
        createdAt: v.number(),
        defaultAt: v.optional(v.number()),
        defaultBranch: v.optional(v.string()),
        deletingAt: v.optional(v.number()),
        organizationId: v.optional(v.string()),
        projectId: v.id("projects"),
        url: v.string(),
        userId: v.optional(v.string()),
    })
        .global()
        .index("by_project_and_url", ["projectId", "url"], { unique: true })
        .index("by_user_and_url", ["userId", "url"])
        .index("by_organization_and_url", ["organizationId", "url"]),

    // A project's rule files, one row per project holding the whole list in order (`projects/rule-files.ts`): kept off the
    // project row, which every project read is charged for whole. Access follows the project's; `userId` copies its owner
    // only so account deletion finds a row whose project is gone (`projects/rule-file-rows.ts`).
    projectRuleFiles: defineTable({
        // The fingerprint of the legacy `context` this list took over, "" or absent for none (`rule-files.ts#contextFingerprint`).
        carriedContext: v.optional(v.string()),
        // When a project delete started erasing it, 0 or absent when none: a sweep finishes one the delete left (`projects/gdpr.ts`).
        deletingAt: v.optional(v.number()),
        files: v.array(
            v.object({
                content: v.string(),
                // An `auto` file's one-line description (`projects/rule-files.ts`).
                description: v.optional(v.string()),
                globs: v.optional(v.array(v.string())),
                id: v.string(),
                mode: v.union(v.literal("always"), v.literal("auto"), v.literal("glob")),
                title: v.string(),
            }),
        ),
        projectId: v.id("projects"),
        updatedAt: v.number(),
        userId: v.optional(v.string()),
        // Counts the saves, absent before the first counted one, so a save writes only over the row it compared against
        // (`writeProjectRuleFiles`).
        version: v.optional(v.number()),
    })
        .global()
        .index("by_project", ["projectId"], { unique: true })
        .index("by_user", ["userId"])
        .index("by_deleting_at", ["deletingAt"]),

    projects: defineTable({
        color: v.optional(v.string()),
        context: v.optional(v.string()),
        createdAt: v.number(),
        defaultEnabledFeatures: v.optional(v.array(v.string())),
        defaultModel: v.optional(v.string()),
        defaultReasoningEffort: v.optional(v.number()),
        description: v.optional(v.string()),
        forkedFromId: v.optional(v.string()),
        galleryCategory: v.optional(v.union(v.literal("image"), v.literal("text"), v.literal("video"), v.literal("audio"), v.literal("automation"))),
        galleryFeatured: v.optional(v.boolean()),
        galleryForkCount: v.optional(v.number()),
        galleryPublishedAt: v.optional(v.number()),
        galleryTags: v.optional(v.array(v.string())),
        galleryViewCount: v.optional(v.number()),
        icon: v.optional(v.string()),
        isPublic: v.optional(v.boolean()),
        // The device the project's folder lives on (this computer, or an SSH server's device) and the absolute folder path on it.
        machineId: v.optional(v.id("devices")),
        order: v.optional(v.number()),
        // When the project last changed organization: a person's runner default from a thread started before it no longer applies.
        organizationChangedAt: v.optional(v.number()),
        organizationId: v.optional(v.string()),
        path: v.optional(v.string()),
        pinnedAt: v.optional(v.number()),
        projectType: v.optional(v.union(v.literal("chat"), v.literal("workflow"))),
        publicAccessToken: v.optional(v.string()),
        // The runner a new thread here starts on by default: the computer, agent and folder id of its last host thread (`acp/lib/project-runner.ts`).
        // Personal projects only; an organization project keeps each person's default on `userSettings.projectRunnerDefaults`. The folder path never leaves the desktop.
        runnerAgentKey: v.optional(v.string()),
        runnerDeviceId: v.optional(v.string()),
        runnerFolderId: v.optional(v.string()),
        runnerKind: v.optional(v.literal("host")),
        // When the thread that recorded the runner started: an older thread opening a session later leaves it.
        runnerThreadAt: v.optional(v.number()),
        // That thread's id: of two threads started in the same millisecond, the one with the greater id keeps the runner.
        runnerThreadId: v.optional(v.string()),
        // Per-project overrides of the owner's sub-agent roles (`sub-agents/roles.ts`).
        subAgentRoles: v.optional(vSubAgentRoles),
        title: v.string(),
        updatedAt: v.optional(v.number()),
        userId: v.optional(v.string()),
        workflowContent: v.optional(
            v.object({
                edges: v.array(
                    v.object({
                        id: v.string(),
                        source: v.string(),
                        sourceHandle: v.optional(v.string()),
                        target: v.string(),
                        targetHandle: v.optional(v.string()),
                        type: v.optional(v.string()),
                    }),
                ),
                nodes: v.array(v.object({ data: v.any(), id: v.string(), position: v.object({ x: v.number(), y: v.number() }), type: v.string() })),
                viewport: v.optional(v.object({ x: v.number(), y: v.number(), zoom: v.number() })),
            }),
        ),
    })
        // `.global()`, not `.shardBy("userId")`: read across users.
        .global()
        .index("by_user_and_pinned", ["userId", "pinnedAt"])
        .index("by_user_and_type", ["userId", "projectType"])
        .index("by_organization", ["organizationId"])
        .index("by_public", ["isPublic", "galleryPublishedAt"])
        .index("by_public_category", ["isPublic", "galleryCategory"])
        .index("by_public_featured", ["isPublic", "galleryFeatured"])
        .index("by_public_access_token", ["publicAccessToken"])
        .index("by_public_fork_count", ["isPublic", "galleryForkCount"])
        .index("by_forkedFromId", ["forkedFromId"])
        .relations((r) => {
            return {
                threads: r.many("threads", { field: "projectId" }),
            };
        }),

    promptHistory: defineTable({
        changeType: v.string(),
        content: v.string(),
        // Who wrote this version's words, as on `prompts` (`prompts/content-author.ts`); a restore carries it back.
        contentBy: v.optional(v.string()),
        contentByImpersonator: v.optional(v.boolean()),
        contentByOthers: v.optional(v.boolean()),
        createdAt: v.number(),
        description: v.optional(v.string()),
        enabledFeatures: v.optional(v.array(v.string())),
        model: v.optional(v.string()),
        note: v.optional(v.string()),
        promptId: v.id("prompts"),
        reasoningEffort: v.optional(v.number()),
        tags: v.optional(v.array(v.string())),
        userId: v.string(),
        variables: v.optional(
            v.array(
                v.object({ defaultValue: v.optional(v.string()), description: v.optional(v.string()), name: v.string(), required: v.optional(v.boolean()) }),
            ),
        ),
        version: v.number(),
    })
        // `.global()`, not `.shardBy("userId")`: read across users.
        .global()
        .index("by_prompt_version", ["promptId", "version"])
        .relations((r) => {
            return {
                prompt: r.one("prompts", { field: "promptId" }),
            };
        })
        .triggers((t) => auditTriggersFor(t, "promptHistory", AUDIT_TABLES["promptHistory"]!)),

    prompts: defineTable({
        content: v.string(),
        // Who wrote the words (`content`, variable defaults), from the session, never from input
        // (`prompts/content-author.ts`): an org member can edit a teammate's prompt and an impersonating admin writes
        // under the user's id, so `userId` does not say whose words it holds. `contentBy` is the last writer;
        // `contentByOthers` and `contentByImpersonator` are set once anyone else, or anyone impersonated, wrote part of
        // them, and only a restore clears them. Unset on rows from before them.
        contentBy: v.optional(v.string()),
        contentByImpersonator: v.optional(v.boolean()),
        contentByOthers: v.optional(v.boolean()),
        currentVersion: v.optional(v.number()),
        description: v.optional(v.string()),
        enabledFeatures: v.optional(v.array(v.string())),
        isFavorite: v.optional(v.boolean()),
        lastUsedAt: v.optional(v.number()),
        model: v.optional(v.string()),
        name: v.string(),
        organizationId: v.optional(v.string()),
        reasoningEffort: v.optional(v.number()),
        tags: v.optional(v.array(v.string())),
        updatedAt: v.optional(v.number()),
        usageCount: v.optional(v.number()),
        userId: v.string(),
        variables: v.optional(
            v.array(
                v.object({ defaultValue: v.optional(v.string()), description: v.optional(v.string()), name: v.string(), required: v.optional(v.boolean()) }),
            ),
        ),
    })
        // `.global()`, not `.shardBy("userId")`: read across users.
        .global()
        .index("by_user_and_favorite", ["userId", "isFavorite"])
        .index("by_organization_and_favorite", ["organizationId", "isFavorite"])
        .searchIndex("search_prompts", { field: "name", filterFields: ["userId"] })
        // NOT `search_prompts_content`: FTS5 names its shadow tables `<fts>_content`,
        // `<fts>_data`, `<fts>_idx`, … so the index above (`search_prompts`) already
        // owns `prompts__fts_search_prompts_content`. Declaring a second index whose
        // own FTS table lands on that exact name makes the shard DO's
        // `ensureMigrated` throw `object name reserved for internal use`, which took
        // every sharded table down.
        .searchIndex("search_prompt_body", { field: "content", filterFields: ["userId"] })
        .relations((r) => {
            return {
                history: r.many("promptHistory", { field: "promptId" }),
            };
        })
        .triggers((t) => auditTriggersFor(t, "prompts", AUDIT_TABLES["prompts"]!)),

    // Develop mode (`source-control/`): the AI guide of a pull request, one row per (user, host origin,
    // repository, number, head commit). A guide is about the head it was built for; a pull request that has
    // moved on reads it as stale. Written by the generation job and the host turn's finalizer only; the page
    // changes nothing but a proposal's status.
    pullRequestGuides: defineTable({
        createdAt: v.number(),
        // Why it did not finish, when `status` is `failed`.
        failure: v.optional(vGuideFailure),
        // 0 until the guide is ready.
        generatedAt: v.number(),
        headSha: v.string(),
        hostOrigin: v.string(),
        // The user's review instructions this guide was written under; a regenerate starts from them.
        instructions: v.string(),
        // The queue job's claim key (cloud); ties a dead delivery to this row.
        jobId: v.optional(v.string()),
        // Changed files the host would not list, so the guide cannot name them.
        leftOut: v.number(),
        number: v.number(),
        proposals: v.array(vGuideProposal),
        repository: v.string(),
        source: vGuideSource,
        status: vGuideStatus,
        stops: v.array(vGuideStop),
        summary: v.string(),
        // The coding-agent thread that writes a host guide.
        threadId: v.optional(v.string()),
        updatedAt: v.number(),
        userId: v.string(),
    })
        .shardBy("userId")
        .index("by_user_and_pull", ["userId", "hostOrigin", "repository", "number"])
        .index("by_threadId", ["threadId"]),

    // Where the housekeeping sweep's state refresh (`source-control/pr-state.ts`) resumes its scan of the owner's
    // `pullRequestThreads`, one row per person. Null starts from the first link. Erased with the links.
    pullRequestStateScans: defineTable({
        cursor: v.union(v.string(), v.null()),
        userId: v.string(),
    })
        .shardBy("userId")
        .index("by_userId", ["userId"]),

    // Develop mode: the thread a pull request is worked on in, and the pull requests a coding agent opened FROM a
    // thread. `kind` says which: `attached` when the person started work on it ("Work on this PR"), `opened` when a run
    // it belonged to opened it. One row per (user, repository, number, kind) at most; the thread id is the link both
    // ways, so the PR lists its threads and a thread names its PR.
    pullRequestThreads: defineTable({
        baseBranch: v.optional(v.string()),
        createdAt: v.number(),
        headBranch: v.optional(v.string()),
        // `attached`: a thread started on the pull request. `linked`: an existing thread linked by hand. `opened`: a run opened it.
        kind: v.union(v.literal("attached"), v.literal("linked"), v.literal("opened")),
        // The last archive attempt for this merge that found the chat busy. The next read tries the least recently attempted links first.
        mergeAttemptedAt: v.optional(v.number()),
        // Set once the pull request is seen merged (`source-control/pr-merged.ts#recordMergedPullRequest`). Written once: a merge is terminal.
        mergedAt: v.optional(v.number()),
        // The exclusive upper bound of the merge's time, as the recorder was given it. Unset: the merge is bounded by `mergedAt` plus a second.
        mergedBefore: v.optional(v.number()),
        // When this link first recorded the merge. A merge is seen only after it happened, so this bounds the merge from above even
        // without a host time; the reopen guard reads it (`agent/auto-archive.ts`).
        mergeRecordedAt: v.optional(v.number()),
        // Set once this merge's archive attempt for the link finished: archived, or declined by a guard or the setting. Until then a read retries it.
        mergeSettledAt: v.optional(v.number()),
        number: v.number(),
        repository: v.string(),
        // The host's state of the pull request, as the last refresh read it (`source-control/pr-state.ts`). Absent until the
        // first read: an unknown state keeps the thread out of auto-archive, like an open one.
        state: v.optional(v.union(v.literal("open"), v.literal("closed"), v.literal("merged"))),
        stateCheckedAt: v.optional(v.number()),
        // The last time a chat's view read this pull request's state from the host. The header reads the least recently read
        // links first, so a link past the first few still gets its merge seen (`source-control/pr-status.ts`).
        statusReadAt: v.optional(v.number()),
        // Set while the thread is soft-deleted, so the sidebar count reads these rows alone. Kept in step by the thread's delete and restore.
        threadDeleted: v.optional(v.boolean()),
        threadId: v.id("threads"),
        title: v.string(),
        url: v.string(),
        userId: v.string(),
        // The person asked for this thread to be woken when the pull request fails checks, conflicts or gets a review
        // (`source-control/pr-watch-logic.ts`). Absent: no watch. Its keys are the decision's stored keys (`pr-watch-logic.ts#storedWatchOf`); the pending reasons live in `watchPending`.
        watch: v.optional(
            v.object({
                baselined: v.optional(v.boolean()),
                checksHeadSha: v.optional(v.string()),
                conflictHeadSha: v.optional(v.string()),
                headSha: v.optional(v.string()),
                lastWakeAt: v.optional(v.number()),
                reviewId: v.optional(v.string()),
                startedAt: v.number(),
                // Set when the person stopped the watch, or the pull request ended it. A stopped watch is kept, not removed.
                stoppedAt: v.optional(v.number()),
                wakes: v.optional(v.number()),
            }),
        ),
        // True exactly while a watch runs, so a person's running watches are counted exactly through an index. Cleared by anything that ends a watch.
        watchActive: v.optional(v.boolean()),
        // The poller's lease: when it last took this watch for a host read (`source-control/pr-watch-poll.ts`). A read's answer lands only while it still matches.
        watchCheckedAt: v.optional(v.number()),
        // When the watch may next be polled: the end of the lease a read holds (`watchCheckedAt` is its id), or one interval after the last recorded read.
        watchLeaseUntil: v.optional(v.number()),
        // Occurrences seen during a cooldown, delivered once the cooldown has passed (`source-control/pr-watch-logic.ts`).
        // Cleared by a fresh start; a stopped watch keeps whatever it had.
        watchPending: v.optional(v.array(v.union(v.literal("checks"), v.literal("conflict"), v.literal("review")))),
        // How the poller's host reads are failing, so a watch that cannot be read is not invisible (`source-control/pr-watch-poll.ts`): the last failure's
        // status and time, and how many reads in a row failed. Reset to zero attempts by the next read that lands. Never changes the watch's decision state.
        watchReadFailure: v.optional(
            v.object({
                at: v.number(),
                attempts: v.number(),
                status: v.union(
                    v.literal("forbidden"),
                    v.literal("host_error"),
                    v.literal("needs_reconnect"),
                    v.literal("not_connected"),
                    v.literal("not_found"),
                    v.literal("rate_limited"),
                ),
            }),
        ),
        // Names one start of the watch: fresh at every start and never the clock, so a poll leased before a stop and restart cannot match the restarted watch (`source-control/pr-watch-poll.ts`).
        watchRun: v.optional(v.string()),
    })
        .shardBy("userId")
        .index("by_user_and_repository_number", ["userId", "repository", "number"])
        .index("by_user_and_repository_number_threadId", ["userId", "repository", "number", "threadId"])
        .index("by_user_and_threadId", ["userId", "threadId"])
        .index("by_user_and_watchActive", ["userId", "watchActive"]),

    // A phone's Expo push token (`notifications/native-push.ts`): one row per token, owned by the account signed in on
    // that phone. Global (D1) and keyed by `token`, so a second account signing in on the same phone moves the row in
    // one write instead of reaching into the first account's shard. Web Push subscriptions live in `@lunora/notify`'s
    // store.
    pushDevices: defineTable({
        // Android only: the app's background task builds the alert, so the push carries no alert of its own. Set by the
        // build that runs the task; a build without it (or an older one) gets the notification-style push.
        buildsAlert: v.optional(v.boolean()),
        createdAt: v.number(),
        // The phone's language (a BCP 47 tag the app reports), for the placeholder alert's wording.
        language: v.optional(v.string()),
        lastSeenAt: v.number(),
        platform: v.union(v.literal("android"), v.literal("ios")),
        // The sign-in that registered the phone: once it ends or expires, the phone gets nothing more.
        sessionId: v.string(),
        token: v.string(),
        userId: v.string(),
    })
        .global()
        // Unique: two registrations of one phone racing each other must not leave a row for each account.
        .index("by_token", ["token"], { unique: true })
        .index("by_userId", ["userId"]),

    /**
     * better-auth's own rate-limit store.
     *
     * `src/server.ts` deliberately does not run `ensureMigrated` (it drives
     * better-auth's migrator, which the Lunora D1 adapter does not support and
     * which `process.exit`s the isolate). Every other better-auth table is
     * declared here for that reason — this one was missed, so `/api/auth/*`
     * answered 500 with `D1_ERROR: no such table: rateLimit` on the first
     * request that tripped the limiter.
     *
     * Column names are better-auth's, not ours: it queries this table directly.
     */
    rateLimit: defineTable({
        count: v.number(),
        key: v.string(),
        lastRequest: v.number(),
    })
        .externallyManaged()
        .global()
        .index("key", ["key"])
        // `auth/rate-limit-sweep.ts` deletes rows past every limiter window.
        .index("by_lastRequest", ["lastRequest"]),

    /**
     * Backing table for `@lunora/ratelimit`'s `createDbStore`.
     *
     * Root shard, deliberately NOT `.global()`, for two reasons:
     *
     *  1. The store reads through `query()/withIndex()`, which the D1 backend
     *     does not implement — on a `.global()` table every rate-limited
     *     mutation dies with "the legacy query()/withIndex() reader is not
     *     available on the D1 (global) backend".
     *  2. Each operation is a read-then-write with no enclosing transaction.
     *     In a DO the input gate serialises that pair; on D1 nothing does, so
     *     concurrent callers would both read the same count and both be let
     *     through.
     */
    rateLimits: defineTable({
        key: v.string(),
        prev: v.optional(v.number()),
        ts: v.number(),
        value: v.number(),
    })
        .externallyManaged()
        .index("by_key", ["key"])
        // `lib/rate-limit-sweep.ts` deletes rows past every limit's retention.
        .index("by_ts", ["ts"]),
    /**
     * A value the agent asked the user for with `requestSecret` (an API key, a token),
     * kept behind the opaque `ref` the agent sees. `encryptedValue` is BYOK-style
     * ciphertext (`lib/encryption.ts`, `provider-keys`); it exists only while the
     * row is `saved` and is removed in the same write that marks it `used`
     * (`chat/lib/secret-requests.ts`). `use` is the destination the user approved
     * on the card, so a consumer cannot send the value anywhere else. The
     * housekeeping sweep deletes a row once `expiresAt` has passed.
     */
    requestedSecrets: defineTable({
        approvalId: v.string(),
        createdAt: v.number(),
        encryptedValue: v.optional(v.string()),
        expiresAt: v.number(),
        label: v.string(),
        ref: v.string(),
        // The reply that asked (`toolApprovalRuns.config.replyKey`): ending it drops this row's ciphertext, another reply's end does not.
        replyKey: v.optional(v.string()),
        status: v.union(v.literal("saved"), v.literal("used"), v.literal("abandoned")),
        threadId: v.string(),
        use: v.union(
            v.object({ header: v.string(), kind: v.literal("mcp_header"), server: v.string(), url: v.optional(v.string()) }),
            v.object({ kind: v.literal("provider_key"), provider: v.string() }),
        ),
        userId: v.string(),
    })
        .shardBy("userId")
        .index("by_ref", ["ref"])
        .index("by_expiresAt", ["expiresAt"])
        .index("by_threadId", ["threadId"])
        .index("by_userId", ["userId"]),

    // Develop mode (`source-control/`): the review a user is writing on a pull request, kept on the
    // server so it follows them across devices. One row per (user, host origin, repository, number);
    // `commitId` is the head the comment lines refer to. A submit claims the row (`submittingAt` > 0,
    // a lease) and the row goes only once the host has confirmed the review.
    reviewDrafts: defineTable({
        body: v.string(),
        comments: v.array(vDraftComment),
        commitId: v.string(),
        createdAt: v.number(),
        hostOrigin: v.string(),
        number: v.number(),
        repository: v.string(),
        // Moves on every edit: a finished submit tells an edited draft from the one it sent.
        revision: v.number(),
        // When a submit claimed the draft; 0 when none is running.
        submittingAt: v.number(),
        updatedAt: v.number(),
        userId: v.string(),
        verdict: v.union(vReviewVerdict, v.null()),
    })
        .shardBy("userId")
        .index("by_user_and_pull", ["userId", "hostOrigin", "repository", "number"]),

    // The user's outbound run webhook (`run-webhooks/`): one row per user. The secret is encrypted ("tool-keys") and is never
    // read back; a rotation replaces it.
    runWebhooks: defineTable({
        createdAt: v.number(),
        enabled: v.boolean(),
        secretCiphertext: v.string(),
        updatedAt: v.number(),
        url: v.string(),
        userId: v.string(),
    })
        .shardBy("userId")
        .index("by_userId", ["userId"]),

    sandboxActions: defineTable({
        action: v.string(),
        command: v.optional(v.string()),
        durationMs: v.optional(v.number()),
        exitCode: v.optional(v.number()),
        sessionId: v.id("sandboxSessions"),
        stderr: v.optional(v.string()),
        stdout: v.optional(v.string()),
        success: v.number(),
        timestamp: v.number(),
    }).index("by_sessionId_timestamp", ["sessionId", "timestamp"]),

    sandboxSessions: defineTable({
        // Set for a bot's computer: one long-lived sandbox per bot, paused when idle
        // and resumed on the next call (`chat/tools/sandbox-node.ts`). No threadId.
        botId: v.optional(v.id("bots")),
        cleanupFnId: v.optional(v.string()),
        completedAt: v.optional(v.number()),
        errorMessage: v.optional(v.string()),
        lastActivityAt: v.number(),
        sandboxId: v.optional(v.string()),
        startedAt: v.number(),
        status: v.string(),
        templateId: v.optional(v.string()),
        threadId: v.optional(v.id("threads")),
        timeoutMs: v.optional(v.number()),
        userId: v.string(),
    })
        .shardBy("userId")
        .index("by_threadId_status", ["threadId", "status"])
        .index("by_botId_status", ["botId", "status"])
        .index("by_userId", ["userId"])
        .index("by_status", ["status"]),

    /**
     * A site login the user saved for the agent's browser (`vault/site-logins.ts`). The password is encrypted
     * (`site-logins` key purpose) and leaves the server only as the keystrokes the browser types. No audit triggers:
     * a history snapshot would keep the ciphertext after the row is gone.
     */
    savedSiteLogins: defineTable({
        createdAt: v.number(),
        encryptedPassword: v.string(),
        label: v.optional(v.string().max(80)),
        // The exact origin (`https://example.com`); a fill types only into a page of this origin.
        origin: v.string().max(255),
        // The page with the login form, an https:// URL on `origin` without its fragment (`vault/lib/site-origin.ts#normalizeSignInUrl`).
        // The fill opens only this page, or the site's front page when unset, never one the model picks.
        signInUrl: v.optional(v.string().max(2048)),
        // Teammates whose threads may use the login. None: only the user's own chats (threads without a teammate).
        teammateIds: v.optional(v.array(v.id("bots"))),
        updatedAt: v.number(),
        userId: v.string(),
        username: v.string().max(320),
    })
        .shardBy("userId")
        .index("by_userId_origin", ["userId", "origin"]),

    session: defineTable({
        activeOrganizationId: v.optional(v.string()),
        activeTeamId: v.optional(v.string()),
        // Which app a grant's session was made for (`auth/lib/sign-in-standing.ts#ClientGrantKind`), set only by the code
        // exchange from the code's redirect URI; unset on a web session. A browser extension's text is not the owner's typing.
        clientGrant: v.optional(v.string()),
        createdAt: v.number(),
        expiresAt: v.number(),
        impersonatedBy: v.optional(v.string()),
        ipAddress: v.optional(v.string()),
        token: v.string(),
        updatedAt: v.number(),
        userAgent: v.optional(v.string()),
        userId: v.string(),
    })
        .externallyManaged()
        .global()
        .index("expiresAt_userId", ["expiresAt", "userId"])
        .index("token", ["token"])
        .index("userId", ["userId"])
        .triggers((t) => auditTriggersFor(t, "session", AUDIT_TABLES["session"]!)),

    /**
     * The user shards that have been active, for the housekeeping fan-out
     * (`lib/shard-housekeeping.ts`). Per-user sweeps — expired temporary chats,
     * streams, presence, exports, lapsed claims — scan tables that now live on
     * each user's own shard, which the root cron tick cannot see. The tick reads
     * this census and runs the sweep ON each shard that is due.
     *
     * One row per shard, upserted at most once per isolate per throttle window.
     */
    shardActivity: defineTable({
        /** When the housekeeping sweep last ran on this shard. */
        housekeptAt: v.optional(v.number()),
        lastActiveAt: v.number(),
        /** The earliest time this shard has timed work due (a schedule trigger, a recurring task); cleared while a tick is in flight. */
        nextDueAt: v.optional(v.number()),
        /**
         * The shard may hold `rateLimits` rows: set by activity and by a charge that adds a row, cleared by the
         * dormant-shard sweep that leaves the table empty (`lib/shard-housekeeping.ts`).
         */
        rateLimitsPending: v.optional(v.boolean()),
        /**
         * When the shard's oldest retained rows expire (`gdpr/retention.ts`), or `NO_RETENTION_DUE` when it holds none (a number, not an absent
         * field, so clearing it is one field write). The shard tick prunes only once this has come, so a tick for other work does not read the
         * retained rows.
         */
        retentionDueAt: v.optional(v.number()),
        shardKey: v.string(),
    })
        .global()
        .index("by_shardKey", ["shardKey"])
        .index("by_lastActiveAt", ["lastActiveAt"])
        .index("by_nextDueAt", ["nextDueAt"])
        .index("by_rateLimitsPending_lastActiveAt", ["rateLimitsPending", "lastActiveAt"]),

    // An erasure's fence on one owner shard: while a row is here, pin writes of the account on this shard are refused in the same
    // transaction as their insert, so a write that commits after the shard's sweep cannot be kept (`lib/account-moves.ts`).
    shardPinFences: defineTable({
        createdAt: v.number(),
        userId: v.string(),
    })
        .shardBy("userId")
        .index("by_user", ["userId"]),

    /**
     * Lookup from a key known BEFORE the owner is to the owner's shard:
     * a public share token, a messenger
     * connection id, a trigger id. The rows they name live on the owner's shard,
     * so a webhook or anonymous public view finds the shard here first.
     *
     * `key` is `<kind>:<value>`; `lib/shard-routes.ts` builds and reads it.
     */
    shardRoutes: defineTable({
        createdAt: v.number(),
        key: v.string(),
        ownerId: v.string(),
    })
        .global()
        .index("by_key", ["key"])
        .index("by_owner", ["ownerId"]),

    /**
     * Where a collaborator's pins on a thread another user owns live: the owner's shard. The pin writers record the route here
     * (`chat/pins/functions.ts`), and the collaborator's data export reads it (`gdpr/steps.ts#collectSharedPins`), so the pins
     * still export after the collaborator's grant is revoked.
     */
    sharedPinRoutes: defineTable({
        createdAt: v.number(),
        ownerId: v.string(),
        threadId: v.id("threads"),
        userId: v.string(),
    })
        .global()
        .index("by_owner", ["ownerId"])
        .index("by_thread", ["threadId"])
        .index("by_user_and_thread", ["userId", "threadId"]),

    /**
     * Sign-up invitations for `@lunora/auth`'s `inviteOnly()` plugin.
     *
     * Hand-transcribed from the plugin's own `schema` block, like every other
     * better-auth table here — better-auth's SQL store issues raw SQL against
     * these column names, so a rename is a runtime `no column named …` inside a
     * 500 with an empty body, not a type error. Fields and nullability match the
     * plugin exactly: `acceptedAt`, `tokenHash`, `invitedBy` optional; `email`
     * unique; `createdAt` and `expiresAt` required.
     *
     * `tokenHash` is a SHA-256 — the plaintext token is returned once by
     * `createSignUpInvitation` and never stored, so a lost invitation link is
     * reissued rather than recovered.
     *
     * Dates are `v.number()` because that is how every other better-auth table
     * here stores them.
     */
    signUpInvitation: defineTable({
        acceptedAt: v.optional(v.number()),
        createdAt: v.number(),
        email: v.string(),
        expiresAt: v.number(),
        invitedBy: v.optional(v.string()),
        tokenHash: v.optional(v.string()),
    })
        .externallyManaged()
        .global()
        // `email` is the only thing an invitation is matched on, on both the
        // sign-up middleware path and the user-create gate.
        .index("email", ["email"])
        // `pruneSignUpInvitations` sweeps by expiry.
        .index("expiresAt", ["expiresAt"]),

    skillFiles: defineTable({
        hash: v.string(),
        language: v.optional(v.string()),
        name: v.string(),
        sizeBytes: v.number(),
        skillId: v.id("skills"),
        storageId: v.string(),
        type: v.string(),
    })
        .global()
        .index("by_skill_and_type", ["skillId", "type"])
        .index("by_hash", ["hash"])
        .relations((r) => {
            return {
                skill: r.one("skills", { field: "skillId" }),
            };
        }),

    skillHistory: defineTable({
        changeType: v.string(),
        config: v.optional(vSkillConfig),
        createdAt: v.number(),
        instructions: v.string(),
        note: v.optional(v.string()),
        skillId: v.id("skills"),
        userId: v.string(),
        variables: v.optional(
            v.array(
                v.object({ defaultValue: v.optional(v.string()), description: v.optional(v.string()), name: v.string(), required: v.optional(v.boolean()) }),
            ),
        ),
        version: v.number(),
    })
        .shardBy("userId")
        .index("by_skill_version", ["skillId", "version"])
        .relations((r) => {
            return {
                skill: r.one("skills", { field: "skillId" }),
            };
        }),

    skillInvocations: defineTable({
        createdAt: v.number(),
        durationMs: v.optional(v.number()),
        errorMessage: v.optional(v.string()),
        parameters: v.optional(v.any()),
        skillId: v.id("skills"),
        status: v.string(),
        threadId: v.optional(v.string()),
        trigger: v.string(),
        userId: v.string(),
    })
        .shardBy("userId")
        .index("by_user", ["userId"])
        .index("by_thread", ["threadId"])
        .index("by_skill_and_status", ["skillId", "status"])
        .relations((r) => {
            return {
                skill: r.one("skills", { field: "skillId" }),
            };
        }),

    skillRatings: defineTable({
        createdAt: v.number(),
        rating: v.number(),
        skillId: v.id("skills"),
        updatedAt: v.optional(v.number()),
        userId: v.string(),
    })
        .global()
        .index("by_user_and_skill", ["userId", "skillId"])
        .index("by_skill", ["skillId"]),

    skills: defineTable({
        category: v.optional(v.string()),
        config: v.optional(vSkillConfig),
        currentVersion: v.optional(v.number()),
        description: v.string(),
        icon: v.optional(v.string()),
        instructions: v.string(),
        name: v.string(),
        organizationId: v.optional(v.string()),
        slug: v.string(),
        source: v.union(
            v.object({ type: v.literal("editor") }),
            v.object({ commitSha: v.optional(v.string()), path: v.optional(v.string()), repoUrl: v.string(), type: v.literal("github") }),
            v.object({ originalSkillId: v.string(), type: v.literal("official") }),
            v.object({ filename: v.string(), type: v.literal("upload"), uploadedAt: v.number() }),
        ),
        tags: v.optional(v.array(v.string())),
        updatedAt: v.optional(v.number()),
        userId: v.string(),
        variables: v.optional(
            v.array(
                v.object({ defaultValue: v.optional(v.string()), description: v.optional(v.string()), name: v.string(), required: v.optional(v.boolean()) }),
            ),
        ),
        version: v.optional(v.string()),
        visibility: v.optional(v.string()),
    })
        .global()
        .index("by_user_and_slug", ["userId", "slug"])
        .index("by_organization", ["organizationId"])
        .index("by_category", ["category"])
        .index("by_visibility", ["visibility"])
        .searchIndex("search_skills_name", { field: "name", filterFields: ["userId"] })
        .searchIndex("search_skills_description", { field: "description", filterFields: ["userId"] })
        .relations((r) => {
            return {
                files: r.many("skillFiles", { field: "skillId" }),
                history: r.many("skillHistory", { field: "skillId" }),
                invocations: r.many("skillInvocations", { field: "skillId" }),
                userSkills: r.many("userSkills", { field: "skillId" }),
            };
        }),

    skillStats: defineTable({
        lastUsedAt: v.optional(v.number()),
        rating: v.optional(v.number()),
        ratingCount: v.optional(v.number()),
        skillId: v.id("skills"),
        usageCount: v.optional(v.number()),
    })
        .global()
        .index("by_skillId", ["skillId"])
        .index("by_usage", ["usageCount"])
        .relations((r) => {
            return {
                skill: r.one("skills", { field: "skillId" }),
            };
        }),

    streamDeltas: defineTable({
        end: v.number(),
        parts: v.array(v.any()),
        start: v.number(),
        streamId: v.id("streamingMessages"),
    }).index("streamId_start_end", ["streamId", "start", "end"]),

    streamingMessages: defineTable({
        agentName: v.optional(v.string()),
        format: v.optional(v.union(v.literal("UIMessageChunk"), v.literal("TextStreamPart"))),
        model: v.optional(v.string()),
        order: v.number(),
        provider: v.optional(v.string()),
        providerOptions: v.optional(v.record(v.string(), v.record(v.string(), v.any()))),
        state: v.union(
            v.object({
                kind: v.literal("streaming"),
                lastHeartbeat: v.number(),
                timeoutFnId: v.optional(v.string()),
            }),
            v.object({
                cleanupFnId: v.optional(v.string()),
                endedAt: v.number(),
                kind: v.literal("finished"),
            }),
            v.object({
                kind: v.literal("aborted"),
                reason: v.string(),
            }),
        ),
        // Denormalised from `state.kind` — Lunora cannot index nested field paths.
        stateKind: v.union(v.literal("streaming"), v.literal("finished"), v.literal("aborted")),
        stepOrder: v.number(),
        threadId: v.id("threads"),
        userId: v.optional(v.string()),
    })
        .shardBy("userId")
        .index("threadId_state_order_stepOrder", ["threadId", "stateKind", "order", "stepOrder"])
        .index("by_userId", ["userId"]),

    // A `delegateToSubAgent` run (`sub-agents/`): a headless agent run in its
    // own child thread, whose answer is posted back to `parentThreadId`.
    // `depth` is 1 under a user's own thread, 2 under a sub-agent's.
    subAgentRuns: defineTable({
        // The last heartbeat of a cloud run's loop (`sub-agents/execute.ts`): a running run whose beat goes stale died
        // with its worker, and `watchRunBeat` ends it. Unset until the first beat; `startedAt` stands in for it.
        beatAt: v.optional(v.number()),
        // The task, trigger or eval run whose chain this run belongs to (`sub-agents/logic.ts:chainSourceKey`); unset for a
        // chain the owner's chat started. One waiting child per source (`chainWaitProblem`); an eval's chain never waits.
        chainSource: v.optional(v.string().max(200)),
        childThreadId: v.optional(v.string()),
        // Set on a run the user typed into a worker thread (`dispatchToWorker`); the dedupe key of that dispatch.
        clientId: v.optional(v.string()),
        completedAt: v.optional(v.number()),
        createdAt: v.number(),
        depth: v.number(),
        // Who sent this dispatch (`sub-agents/logic.ts:DISPATCH_SOURCES`); unset on rows from before it was recorded.
        dispatchedBy: v.optional(vDispatchSource),
        error: v.optional(v.string()),
        // How many times a host run's message met a busy computer and was put back in line to try again
        // (`sub-agents/host-runs.ts:HOST_START_MAX_ATTEMPTS`); unset until the first.
        hostStartAttempts: v.optional(v.number()),
        // A host run's turn (`persistentStreams.hostTurnId`): the host's `turn_end` finishes the run that sent it,
        // and a turn nobody dispatched (one typed in the desktop window) finishes none.
        hostTurnId: v.optional(v.string()),
        // Set when the loop of a run that was stopped while running is known to be gone (it reported, or the
        // reaper fired): until then it may still write into the worker's thread, so the next message waits.
        loopExitedAt: v.optional(v.number()),
        // Unset = a one-shot run. A worker's child thread is created with its first run and every later
        // dispatch is one more row on it; the worker is the thread, not a table.
        mode: v.optional(vSubAgentRunMode),
        organizationId: v.optional(v.string()),
        // The delegating run's model, inherited when still allowed.
        parentModel: v.optional(v.string()),
        parentThreadId: v.string(),
        // When the run's current post check is due: a release that would not move it forward schedules nothing.
        postCheckAt: v.optional(v.number()),
        // The token of the run's current post check (`postResult`): a check acts only while its token is current, so a
        // release supersedes the pending one instead of adding a second loop.
        postCheckId: v.optional(v.string()),
        // Why the result never reached the parent thread, once the retries ran out. Terminal: set
        // instead of `resultPostedAt`, never with it.
        postFailed: v.optional(v.string()),
        // A one-shot run's reaper deadline once it waited on an approval (`awaiting`): the approval's expiry while it
        // waits, a fresh run window once it resumes. Unset = the window from `createdAt`.
        reapAt: v.optional(v.number()),
        result: v.optional(v.string()),
        // When the result was written to the parent thread, in the same transaction as the message.
        // The post waits while the parent is still streaming (`sub-agents/functions.ts:postRunResult`).
        resultPostedAt: v.optional(v.number()),
        // The approval id the run last resumed with (`resumeRunForAnswer`): its continuation streams under that key.
        resumedBy: v.optional(v.string()),
        // The role the run launched with, resolved at admission (`sub-agents/roles.ts`).
        role: v.optional(vSubAgentRunRole),
        runner: v.optional(vSubAgentRunner),
        skillSlug: v.optional(v.string()),
        startedAt: v.optional(v.number()),
        status: vSubAgentRunStatus,
        task: v.string(),
        // Unset = the child's normal headless tool set.
        toolAllowlist: v.optional(v.array(v.string())),
        toolCallId: v.optional(v.string()),
        updatedAt: v.number(),
        userId: v.string(),
    })
        .shardBy("userId")
        .index("by_parentThreadId_and_status", ["parentThreadId", "status"])
        .index("by_childThreadId", ["childThreadId"])
        .index("by_childThreadId_and_status", ["childThreadId", "status"])
        // A waiting run's deadline, for the backstop that reaps one whose own reaper was lost (`reapOverdueWaits`).
        .index("by_status_and_reapAt", ["status", "reapAt"])
        .index("by_user_and_status", ["userId", "status"])
        .index("by_user_and_toolCallId", ["userId", "toolCallId"])
        .index("by_user_and_createdAt", ["userId", "createdAt"])
        // A chain source's waiting child, which refuses that source's next delegation (`admitSubAgentRun`).
        .index("by_chainSource_and_status", ["chainSource", "status"])
        // The retention sweep (`gdpr/retention.ts`), which serves a whole shard.
        .index("by_createdAt", ["createdAt"]),

    systemPromptPresets: defineTable({
        createdAt: v.number(),
        description: v.optional(v.string()),
        modelId: v.optional(v.string()),
        name: v.string(),
        organizationId: v.optional(v.string()),
        prompt: v.string(),
        updatedAt: v.number(),
        userId: v.string(),
    })
        .shardBy("userId")
        .index("by_userId_modelId", ["userId", "modelId"]),

    /**
     * One row per agent attempt at a task (`tasks/execute.ts`): round 0 is the
     * first attempt of a cycle, rounds 1..N are verifier-driven repairs. `cycle`
     * is the task's `activeCycle` token when the round was claimed — the claim
     * and the completion both check it, which is what makes a retried or late
     * action a no-op instead of a second run.
     */
    taskRuns: defineTable({
        completedAt: v.optional(v.number()),
        cycle: v.string(),
        error: v.optional(v.string()),
        finalAnswer: v.optional(v.string()),
        origin: vTaskRunOrigin,
        round: v.number(),
        startedAt: v.number(),
        status: vTaskRunStatus,
        taskId: v.id("tasks"),
        threadId: v.optional(v.string()),
        userId: v.string(),
        verdict: v.optional(vVerdict),
    })
        .shardBy("userId")
        .index("by_task_and_startedAt", ["taskId", "startedAt"])
        .index("by_cycle_and_round", ["cycle", "round"])
        .index("by_user", ["userId"]),

    // Agent-run tasks with a verifier (`tasks/`). Sharded with `goals` and
    // `taskRuns`, which the same mutations write.
    tasks: defineTable({
        // The current queue cycle's token; unset when the task is at rest.
        activeCycle: v.optional(v.string()),
        attemptCount: v.number(),
        // Set when a coding agent, not the chat agent, works the task (`coding-agents/`).
        codingAgent: v.optional(vCodingAgentAssignment),
        createdAt: v.number(),
        // Recurrence, in the trigger schedule format (5-field UTC cron).
        cronExpression: v.optional(v.string()),
        dependsOn: v.array(v.id("tasks")),
        goalId: v.optional(v.id("goals")),
        instructions: v.string(),
        lastError: v.optional(v.string()),
        // Why the last run did not go where the task says, and when (`vTaskRunNoticeReason`); cleared by a run that did.
        lastRunNotice: v.optional(v.object({ at: v.number(), reason: vTaskRunNoticeReason })),
        lastRunThreadId: v.optional(v.string()),
        // The last recurrence slot the sweep let pass without a run, and why (`tasks/AGENTS.md`).
        lastSkippedAt: v.optional(v.number()),
        lastSkipReason: v.optional(vTaskSkipReason),
        maxRepairRounds: v.number(),
        model: v.optional(v.string()),
        nextRunAt: v.optional(v.number()),
        // The creator's active organization when the task was last saved —
        // server-side, never from args. Lets a headless run resolve a skill
        // shared with that organization, after re-checking membership.
        organizationId: v.optional(v.string()),
        parentTaskId: v.optional(v.id("tasks")),
        // The project a run's new thread is filed in; a run continues a thread only while it is still in this project.
        projectId: v.optional(v.id("projects")),
        // 0-100, the chat's reasoning-effort scale; unset leaves it to the skill or the model.
        reasoningEffort: v.optional(v.number()),
        // Denormalised `cronExpression !== undefined`, so the due scan has an equality prefix.
        recurring: v.boolean(),
        resultSummary: v.optional(v.string()),
        reviewNote: v.optional(v.string()),
        // Where a recurring run goes; unset is a new thread each run.
        runDestination: v.optional(vTaskRunDestination),
        skillId: v.optional(v.id("skills")),
        status: vTaskStatus,
        // When the stuck sweep next looks at this task; unset once its episode has no notice left (`tasks/AGENTS.md`).
        stuckCheckAt: v.optional(v.number()),
        // The last stuck notice sent (2 or 7 idle days) and the episode it was sent in (`updatedAt` when that began).
        stuckNotice: v.optional(v.object({ days: v.number(), since: v.number() })),
        successCriteria: v.optional(v.string()),
        title: v.string(),
        updatedAt: v.number(),
        userId: v.string(),
    })
        .shardBy("userId")
        .index("by_user_and_status", ["userId", "status"])
        .index("by_user_and_goal", ["userId", "goalId"])
        .index("by_recurring_and_nextRunAt", ["recurring", "nextRunAt"])
        .index("by_status_and_updatedAt", ["status", "updatedAt"])
        .index("by_status_and_stuckCheckAt", ["status", "stuckCheckAt"]),

    /**
     * A scheduled task proposed from the user's own messages (`tasks/suggestions.ts`), waiting for an accept or a
     * dismiss. Nothing here runs: accepting creates a task through the normal path and records its id. The row keeps
     * the proposal in the task's own shape and only the ids of the chats it came from, never message text.
     */
    taskSuggestions: defineTable({
        createdAt: v.number(),
        // The proposed schedule, in the task's format (5-field UTC cron).
        cronExpression: v.string(),
        // Set with `status` when the person accepts or dismisses.
        decidedAt: v.optional(v.number()),
        instructions: v.string(),
        // Where it came from: the chats (at most `MAX_SUGGESTION_SOURCES`) whose messages the idea was drawn from.
        sourceThreadIds: v.array(v.string()),
        status: vTaskSuggestionStatus,
        // The task an accept created.
        taskId: v.optional(v.id("tasks")),
        title: v.string(),
        userId: v.string(),
    })
        .shardBy("userId")
        .index("by_user_and_status_and_createdAt", ["userId", "status", "createdAt"])
        // The trim of decided rows keeps the most recently decided (`trimDecidedSuggestions`).
        .index("by_user_and_status_and_decidedAt", ["userId", "status", "decidedAt"]),

    team: defineTable({
        createdAt: v.number(),
        // better-auth 1.7.3's seat counter: `addTeamMemberWithLimit` reserves a
        // seat by incrementing it before inserting the `teamMember` row. A NULL
        // here fails its `memberCount < limit` guard, so every insert must write
        // a number — better-auth writes 0, and so does our `createTeam`. Optional
        // only so the schema-drift gate reads it as additive.
        memberCount: v.optional(v.number()),
        name: v.string(),
        organizationId: v.string(),
        updatedAt: v.optional(v.number()),
    })
        .externallyManaged()
        .global()
        .index("organizationId", ["organizationId"])
        .index("name", ["name"])
        .triggers((t) => auditTriggersFor(t, "team", AUDIT_TABLES["team"]!)),

    // A teammate's access to one connection (`connectors/access.ts`). No row means the default, read and write. Owned by the
    // connectors module; erased with the user (`connectors/gdpr.ts`).
    teammateConnectorAccess: defineTable({
        botId: v.id("bots"),
        connectorSlug: v.string().max(200),
        level: v.union(v.literal("read_only"), v.literal("read_write"), v.literal("none")),
        updatedAt: v.number(),
        userId: v.string(),
    })
        .shardBy("userId")
        .index("by_botId_connectorSlug", ["botId", "connectorSlug"])
        // The app proxy's check for a call that names no thread: every teammate's setting for one connection (`access.ts`).
        .index("by_userId_connectorSlug", ["userId", "connectorSlug"])
        .index("by_userId", ["userId"])
        .triggers((t) => auditTriggersFor(t, "teammateConnectorAccess", AUDIT_TABLES["teammateConnectorAccess"]!)),

    teamMember: defineTable({
        createdAt: v.optional(v.number()),
        // SHA-256 of `[teamId, userId]`, written by better-auth 1.7.3 as its
        // per-team uniqueness key. Our own `addTeamMember` leaves it unset;
        // better-auth falls back to the (teamId, userId) pair lookup.
        membershipKey: v.optional(v.string()),
        // OURS, not better-auth's — it never writes this column, so it must be
        // optional or every better-auth insert into `teamMember` fails. A row
        // without one is a plain member (`team-helpers.ts`).
        role: v.optional(v.union(v.literal("admin"), v.literal("member"))),
        teamId: v.string(),
        userId: v.string(),
    })
        .global()
        .index("userId", ["userId"])
        .index("teamId_userId", ["teamId", "userId"])
        .index("teamId_role", ["teamId", "role"])
        .index("membershipKey", ["membershipKey"])
        .triggers((t) => auditTriggersFor(t, "teamMember", AUDIT_TABLES["teamMember"]!)),

    teamSettings: defineTable({
        allowedModels: v.optional(v.array(v.string())),
        organizationId: v.string(),
        teamId: v.string(),
    })
        .global()
        .index("teamId", ["teamId"])
        .index("organizationId", ["organizationId"])
        .triggers((t) => auditTriggersFor(t, "teamSettings", AUDIT_TABLES["teamSettings"]!)),

    temporaryThreads: defineTable({
        expiresAt: v.number(),
        retentionHours: v.optional(v.number()),
        /**
         * An unsaved skill draft an Agent Builder "test drive" runs against. It
         * lives on this row so it is deleted with the temporary thread, and a
         * thread converted to permanent drops it and runs as plain chat.
         */
        skillDraft: v.optional(
            v.object({
                config: v.optional(vSkillConfig),
                instructions: v.string(),
                name: v.string(),
            }),
        ),
        threadId: v.id("threads"),
        userId: v.optional(v.string()),
    })
        .shardBy("userId")
        .index("by_thread", ["threadId"])
        .index("by_expiresAt", ["expiresAt"])
        .index("by_userId_expiresAt", ["userId", "expiresAt"]),

    threadAccess: defineTable({
        expiresAt: v.optional(v.number()),
        grantedAt: v.number(),
        grantedBy: v.string(),
        /** The thread's owner — the shard the thread lives on, and the key `authorizeShard` admits the grantee to. */
        ownerId: v.optional(v.string()),
        permission: v.union(v.literal("read"), v.literal("write"), v.literal("admin")),
        /** Advanced by every write to the grant (`agent/grant-revision.ts`); absent on a grant from before revisions (0). */
        revision: v.optional(v.number()),
        threadId: v.id("threads"),
        userId: v.string(),
    })
        // `.global()`, not `.shardBy("userId")`: read across users.
        .global()
        .index("by_thread_and_user", ["threadId", "userId"])
        .index("by_user_and_owner", ["userId", "ownerId"])
        // The grants on a user's chats: a guest merge's last check and the owner's erasure, without a table scan.
        .index("by_owner", ["ownerId"])
        .relations((r) => {
            return {
                thread: r.one("threads", { field: "threadId" }),
            };
        }),
    /**
     * The last revision of a thread grant (`agent/grant-revision.ts`), one row per thread and grantee. It outlives the
     * grant row, so a grant written after a removal continues past the removal's revision and a denial names it. Erased
     * when the chat is deleted for good (`revokeThreadGrantsJob` with `purge`) and with either user's account.
     */
    threadAccessRevisions: defineTable({
        /** The thread's owner, so the owner's account deletion erases the row. */
        ownerId: v.optional(v.string()),
        revision: v.number(),
        threadId: v.id("threads"),
        /** The grantee. */
        userId: v.string(),
    })
        .global()
        // Unique: two writers that both find no row cannot both make one (`advanceGrantRevision`).
        .index("by_thread_and_user", ["threadId", "userId"], { unique: true })
        .index("by_user_and_owner", ["userId", "ownerId"])
        .index("by_owner", ["ownerId"]),

    /**
     * A rolling summary of the older rows of ONE path of a thread, made while it
     * sits idle (`agent/thread-summaries.ts`) and fed to the agent ahead of the
     * recent rows. Keyed on the thread and the last row it covers: the context
     * builder uses it only while that row is still an ancestor of the prompt, so
     * a branch the user switched away from never leaks into the other. A few rows
     * per thread (`SUMMARIES_KEPT_PER_THREAD`), erased with the thread.
     */
    threadContextSummaries: defineTable({
        /** Rows of the path covered, counted from its top; orders the rows of one thread. */
        coveredCount: v.number(),
        coveredUpToMessageId: v.id("messages"),
        createdAt: v.number(),
        /**
         * `"compact"` marks a compaction (`agent/thread-compaction.ts`): the user asked for it (or the auto-compact
         * threshold did), so the context builder also drops the rows it covers from what the model is sent, and it
         * does not depend on the idle-summary opt-in. Absent = an idle summary. The stored messages are never touched.
         */
        kind: v.optional(v.literal("compact")),
        summary: v.string(),
        /**
         * The untrusted sources (`devices/lib/taint.ts`) of the rows folded into the summary and of the one it
         * extends. A device call made while the thread holds a summary carries them, so text the model read
         * once, then lost to the window, still makes the call ask. Empty = clean.
         */
        taintedBy: v.array(vDeviceTaintSource),
        threadId: v.id("threads"),
        /** The thread's owner, whose shard this row lives on and whose account erases it. */
        userId: v.string(),
    })
        .shardBy("userId")
        .index("by_threadId", ["threadId"])
        .index("by_userId", ["userId"]),

    // Whether a person follows a thread for new-reply notifications (`chat/follows/functions.ts`). A row exists only
    // once a state is set (by the person, or by share/accept); no row means "off".
    // Global (D1) like `threadAccess`: the follower, the thread's owner and the erasure of either read the same rows.
    threadFollows: defineTable({
        createdAt: v.number(),
        state: v.union(v.literal("on"), v.literal("off"), v.literal("muted")),
        threadId: v.id("threads"),
        updatedAt: v.number(),
        userId: v.string(),
    })
        .global()
        .index("by_thread", ["threadId"])
        .index("by_user_and_thread", ["userId", "threadId"], { unique: true })
        .relations((r) => {
            return {
                thread: r.one("threads", { field: "threadId" }),
            };
        }),
    threadGoals: defineTable({
        // The highest round whose review has been claimed (`chat/goals/internal.ts#claimGoalRound`):
        // the review job is queued at least once, and only the delivery that claims a round reviews it.
        claimedRound: v.optional(v.number()),
        config: vGoalRunConfig,
        costMicrodollars: v.number(),
        createdAt: v.number(),
        endedAt: v.optional(v.number()),
        maxCostMicrodollars: v.number(),
        maxRounds: v.number(),
        organizationId: v.optional(v.string()),
        // The user row that opened the latest round; the review reads the rows after it.
        promptMessageId: v.string(),
        // Reviews recorded so far.
        round: v.number(),
        // The user's own message that started the goal: where the thread shows it.
        startMessageId: v.string(),
        status: vThreadGoalStatus,
        stopReason: v.optional(vGoalStopReason),
        text: v.string(),
        threadId: v.id("threads"),
        updatedAt: v.number(),
        userId: v.string(),
        verdicts: v.array(vGoalVerdict),
    })
        .shardBy("userId")
        .index("by_thread", ["threadId"])
        .index("by_thread_and_status", ["threadId", "status"])
        .index("by_user", ["userId"])
        .index("by_status_and_updatedAt", ["status", "updatedAt"])
        .relations((r) => {
            return {
                thread: r.one("threads", { field: "threadId" }),
            };
        }),
    /**
     * A guest link for one thread (`chat/guest-links.ts`): what a person without access can use to LEAVE a
     * message for the owner. It grants no read of the thread. Only the SHA-256 of the link token is stored
     * (the owner sees the token once, at creation), and `guestHash` is the hash of the one browser's token
     * that first posted. It lasts 24 hours; revoking, archiving or deleting the thread removes it with its
     * held messages. Routed from `shardRoutes` (`guest-link`) so an anonymous request finds the owner's shard.
     */
    threadGuestLinks: defineTable({
        createdAt: v.number(),
        expiresAt: v.number(),
        guestHash: v.optional(v.string()),
        linkHash: v.string(),
        threadId: v.id("threads"),
        userId: v.string(),
    })
        .shardBy("userId")
        .index("by_thread_expiresAt", ["threadId", "expiresAt"])
        .index("by_linkHash", ["linkHash"])
        .index("by_expiresAt", ["expiresAt"])
        .index("by_userId", ["userId"]),

    /**
     * A message a guest left through a link. UNTRUSTED text that waits here: nothing reads it into a model,
     * a title or a summary. Only the owner's Send hands it to the owner's own client, which sends it through
     * the ordinary path; `sent` records that, so the guest sees it was taken up. Dismiss deletes the row.
     */
    threadGuestMessages: defineTable({
        createdAt: v.number(),
        linkId: v.id("threadGuestLinks"),
        status: v.union(v.literal("held"), v.literal("sent")),
        text: v.string(),
        threadId: v.id("threads"),
        userId: v.string(),
    })
        .shardBy("userId")
        .index("by_link", ["linkId"])
        .index("by_thread", ["threadId"])
        .index("by_userId", ["userId"]),

    threadInvites: defineTable({
        acceptedAt: v.optional(v.number()),
        acceptedBy: v.optional(v.string()),
        expiresAt: v.number(),
        invitedBy: v.string(),
        invitedEmail: v.string(),
        inviteToken: v.string(),
        /** The thread's owner, so a token redeemed from the invitee's shard leads to the thread's. */
        ownerId: v.optional(v.string()),
        permission: v.union(v.literal("read"), v.literal("write"), v.literal("admin")),
        status: v.union(v.literal("pending"), v.literal("accepted"), v.literal("expired"), v.literal("revoked")),
        threadId: v.id("threads"),
    })
        // `.global()`, not `.shardBy("userId")`: read across users.
        .global()
        .index("by_thread", ["threadId"])
        .index("by_invite_token", ["inviteToken"])
        .relations((r) => {
            return {
                thread: r.one("threads", { field: "threadId" }),
            };
        }),

    threadKnowledge: defineTable({
        addedAt: v.number(),
        knowledgeFileId: v.id("knowledgeFiles"),
        threadId: v.id("threads"),
    })
        .index("by_threadId", ["threadId"])
        .index("by_knowledgeFileId", ["knowledgeFileId"]),

    // A locked thread's passcode. Kept OUT of `threads` (thread docs reach
    // clients raw), on the owner's shard next to the thread. Hash, salt and the
    // failure/backoff state never leave the backend. `epoch` is what proofs are
    // bound to: rotated by lock, change and removal, so old proofs die.
    threadPasscodes: defineTable({
        createdAt: v.number(),
        epoch: v.string(),
        failedAttempts: v.number(),
        // Set once the chat's file links are indexed (`agent/file-link-backfill.ts`). Unset: the lock gate scans messages.
        filesIndexedAt: v.optional(v.number()),
        hash: v.string(),
        iterations: v.number(),
        lockoutUntil: v.optional(v.number()),
        salt: v.string(),
        threadId: v.id("threads"),
        updatedAt: v.number(),
        userId: v.string(),
    })
        .shardBy("userId")
        .index("by_thread", ["threadId"])
        .index("by_userId", ["userId"])
        .relations((r) => {
            return {
                thread: r.one("threads", { field: "threadId" }),
            };
        }),

    threadPins: defineTable({
        createdAt: v.number(),
        // A document pin's document (in the same thread) and its kind, which the pins tab shows as its icon.
        documentId: v.optional(v.id("documents")),
        documentKind: v.optional(v.string()),
        // An image pin's place among the message's images (`kind: "image"`, `imageOrdinals` in chat-ui); a message pin has none.
        imageIndex: v.optional(v.number()),
        // An image pin's key, a hash of where its image is stored (`imageKeyOf` in the web app): found wherever the image now
        // sits, which an image index alone cannot do when an earlier image is gone. No address is stored.
        imageKey: v.optional(v.string()),
        // What is pinned: the whole message (absent, as every pin before images), one image of it, or a document of the thread.
        kind: v.optional(v.union(v.literal("message"), v.literal("image"), v.literal("document"))),
        // The message a pin quotes. A document pin has one only when its document was made by a message.
        messageId: v.optional(v.string()),
        messageRole: v.union(v.literal("user"), v.literal("assistant")),
        note: v.optional(v.string()),
        selectedText: v.optional(v.string()),
        threadId: v.id("threads"),
        updatedAt: v.number(),
        userId: v.string(),
    })
        .shardBy("userId")
        .index("by_thread", ["threadId"])
        .index("by_thread_and_document", ["threadId", "documentId"])
        .index("by_user_and_thread", ["userId", "threadId"])
        // One document pin per person and document, so pinning the same document again finds it.
        .index("by_user_and_document", ["userId", "documentId"])
        .relations((r) => {
            return {
                thread: r.one("threads", { field: "threadId" }),
            };
        }),

    /**
     * A chat deleted for good (`agent/grant-revision.ts#markThreadPurged`): written by its grant purge before the purge
     * reads a grant or a revision, and read by every write that makes one (a new grant, a new count) after its own write,
     * which then takes it back. So a write the purge's reads miss (an invite accept already past its invite read) finds
     * the mark. Holds no user; dropped a day after the purge finishes (`dropThreadPurgeMark`), when no such write is left.
     */
    threadPurgeMarks: defineTable({
        purgedAt: v.number(),
        threadId: v.id("threads"),
    })
        .global()
        // Unique: a purge redelivered or run twice (a delete and the account's erasure) writes one mark.
        .index("by_thread", ["threadId"], { unique: true }),

    threadRelationships: defineTable({
        branchPoint: v.optional(v.number()),
        // "side": a side chat started beside its parent (`chat/side-chat.ts`); the parent is read, never written.
        branchType: v.optional(v.union(v.literal("branch"), v.literal("continuation"), v.literal("comparison"), v.literal("side"), v.literal("subagent"))),
        createdAt: v.number(),
        parentThreadId: v.id("threads"),
        threadId: v.id("threads"),
        userId: v.optional(v.string()),
    })
        .shardBy("userId")
        .index("by_thread", ["threadId"])
        .index("by_parent_and_thread", ["parentThreadId", "threadId"])
        .index("by_userId", ["userId"])
        .relations((r) => {
            return {
                parentThread: r.one("threads", { field: "parentThreadId" }),
                thread: r.one("threads", { field: "threadId" }),
            };
        }),

    threads: defineTable({
        // Cache of the agent the active path runs on, for the thread list and the composer's
        // first paint; the path's last `agentSwitch` row decides (`agent/agent-switch.ts`).
        // Unset = the thread was never switched, and every send keeps its own model.
        activeAgent: v.optional(vAgentRef),
        // The message the user last pointed the in-thread branch switcher at.
        // Unset = the thread never branched, and reads stay on the linear fast
        // path. The displayed path descends from here by latest child.
        activeLeafMessageId: v.optional(v.string()),
        // When the chat was last archived (by hand, idle, or for a merge). A merge that predates it was covered by that archive, so a
        // later read does not archive the reopened chat again for it (`agent/auto-archive.ts`). Kept on reopen.
        archivedAt: v.optional(v.number()),
        // Each send resolves to one concrete model chosen by the gateway's query routing (`chat/lib/auto-model.ts`).
        // `model` stays a concrete id (the fallback); unset = off. Never set on a switched thread's behalf.
        autoModel: v.optional(v.boolean()),
        // The last run paused for the owner (a tool approval, or an askUser question). Set in the
        // same patch that ends the run (`chat/lib/agent-run.ts#setThreadStatus`); removed by any
        // write that puts the thread back to `running` (`agent/table-writes.ts#patchThread`).
        awaitingInput: v.optional(v.union(v.literal("approval"), v.literal("question"))),
        // The bot this chat was started with. Set once at creation; its
        // instructions are read live on each run (`chat/lib/agent-run.ts`).
        botId: v.optional(v.id("bots")),
        // The organization a temporary chat was started in, kept for its permission cap only
        // (`chat/lib/run-permission-cap.ts`). A temporary chat is never filed under `organizationId`, so it stays off that
        // organization's list, but a later turn sent from another space must not lift the cap it started under.
        // Written by `agent/threads.ts#createTemporaryThread`. Saving or branching the chat files the lasting chat under this
        // organization while its owner is a member, and keeps this field instead once they left (`placeLastingChat`).
        capOrganizationId: v.optional(v.string()),
        category: v.optional(v.string()),
        // The newest context reset on the ACTIVE path, kept by `syncActiveAgent` and the clear writers so a reply reads it in
        // one lookup (`agent/context-reset.ts#resetForTip`). "" = none on the path; unset = not known (walk the path).
        contextResetMessageId: v.optional(v.string()),
        // Creation time in ms, the sidebar's sort key. `_creationTime` is system-set and
        // cannot carry an imported chat's source time; unset on rows from before this column.
        createdAt: v.optional(v.number()),
        createdBy: v.optional(v.string()),
        customSystemPrompt: v.optional(v.string()),
        deleted: v.optional(v.boolean()),
        deletedAt: v.optional(v.number()),
        // Set on a hard delete's first page (`agent/threads.ts`): the thread is going, and a sub-agent's result no longer
        // posts into it (`isGoneParent`), whatever page the delete is on.
        deletingAt: v.optional(v.number()),
        dictationLanguage: v.optional(v.string()),
        enabledFeatures: v.optional(v.array(v.string())),
        externalThreadId: v.optional(v.string()),
        // The suggestion request in flight on this chat, and the grant removal holding requests back: a short lease on the chat's own
        // row, so admission, the lock and the deletes read one shard's row in one transaction (`agent/followup-suggestions.ts`).
        // `expiresAt` 0 (or in the past) is no lease.
        followupDispatch: v.optional(v.object({ claimedAt: v.number(), expiresAt: v.number(), requestId: v.optional(v.string()) })),
        followupRevoke: v.optional(v.object({ claimedAt: v.number(), expiresAt: v.number() })),
        // Multi-agent group chat: participants (skill ids) and who-speaks mode.
        // Written only by `chat/group/functions.ts`, which checks access.
        groupChat: v.optional(vGroupChat),
        // Set once `/clear` writes a context reset on this thread (`chat/context-reset.ts`): unset, a reply never
        // reads the thread's pointer (`agent/context-reset.ts#resetForTip`).
        hasContextReset: v.optional(v.boolean()),
        // Set once a switch on this thread stores a handoff (`chat/agent-switch.ts`): unset, a reply never
        // walks the path looking for one (`agent/agent-switch.ts#handoffAboveOf`).
        hasHandoff: v.optional(v.boolean()),
        isPublic: v.optional(v.boolean()),
        isTemporary: v.optional(v.boolean()),
        language: v.optional(v.string()),
        lastCompressionStartedAt: v.optional(v.number()),
        // When the last run finished successfully; written with the status write that ends it.
        lastReplyAt: v.optional(v.number()),
        // When the user last saved a reply in the thread (not the prompt a routine run opens it with).
        // Written by `agent/messages.ts#addMessagesHandler`; the routines' quiet check reads it.
        lastUserMessageAt: v.optional(v.number()),
        // When the OWNER last viewed the latest reply; written only by `chat/thread-state.ts#markThreadViewed`.
        lastViewedAt: v.optional(v.number()),
        // Set while the thread has a passcode (locked). Content is refused
        // without a proof; `lib/thread-lock.ts`. The hash lives in `threadPasscodes`.
        lockedAt: v.optional(v.number()),
        // Set while a merge owes this chat an archive (`source-control/pr-thread-links.ts#setThreadMergeOwed`), cleared once its owed
        // links settle. The sweep reads a chat's links for an owed merge only while this is set, so a chat with none is never read.
        mergeOwed: v.optional(v.boolean()),
        // Where the sweep's scan for an owed merge stands in this chat's links, saved between sweeps for a chat too large to scan in
        // one mutation. Empty: the scan starts from the first link. Any new owed merge empties it, so a scan cannot pass that link.
        mergeOwedScan: v.optional(v.string()),
        messengerConnectionId: v.optional(v.id("messengerConnections")),
        mode: v.optional(v.string()),
        model: v.optional(v.string()),
        multiChat: v.optional(v.boolean()),
        order: v.optional(v.number()),
        organizationId: v.optional(v.string()),
        parentThreadIds: v.optional(v.array(v.string())),
        // How much of a cloud run the owner leaves unasked (`chat/lib/thread-permission-mode.ts`). Unset = "auto", today's
        // behaviour. Never set on a host thread, whose approvals keep their own rules.
        permissionMode: v.optional(v.union(v.literal("supervised"), v.literal("auto"), v.literal("full"))),
        pinnedAt: v.optional(v.number()),
        // The goal every following message in this chat runs with, until it is cleared (`chat/goals/functions.ts`).
        pinnedGoal: v.optional(vPinnedGoal),
        projectId: v.optional(v.id("projects")),
        publicAccessToken: v.optional(v.string()),
        reasoningEffort: v.optional(v.number()),
        // Where this thread's turns run (`acp/lib/host-thread.ts`): "host" = a coding agent on a paired
        // device. Unset = the cloud. Set at creation, never changed.
        runner: v.optional(v.literal("host")),
        // The sync's claim on embedding this thread's texts (`thread-search.ts`): one job at a time, and it expires.
        searchClaim: v.optional(
            v.object({
                expiresAt: v.number(),
                id: v.string(),
                texts: v.array(v.object({ kind: v.union(v.literal("summary"), v.literal("title")), text: v.string() })),
            }),
        ),
        // When a sync last found the owner's model rules refusing the embedding model: replies re-sync such a thread at most daily.
        searchRefusedAt: v.optional(v.number()),
        // The newest snooze ordering: an owner's choice time (client clock, capped at the server's) or a wake's server time.
        // A queued snooze or unsnooze chosen before it changes nothing (`agent/table-writes.ts#setThreadSnooze`).
        snoozeChosenAt: v.optional(v.number()),
        // Hidden from the owner's active list until then. Written by `chat/thread-state.ts`, cleared by a wake (`agent/table-writes.ts#patchThread`).
        snoozedUntil: v.optional(v.number()),
        source: v.optional(v.string()),
        statelessMode: v.optional(v.boolean()),
        status: v.string(),
        summary: v.optional(v.string()),
        // Moves each time a reply is edited in place; a context summary is stored only if it did not move since the
        // run was prepared (`agent/thread-summaries.ts`). Unset = never edited.
        summaryEpoch: v.optional(v.number()),
        // When a summary run found the path too long to read from the top; later runs skip the walk.
        summaryPathTooLongAt: v.optional(v.number()),
        // Palette search by meaning (`agent/thread-search.ts`): the vector ids of the title and summary, embedded only for a
        // thread with enough turns and not locked. Derived data: never exported, and removed with the thread.
        summaryVectorId: v.optional(v.string()),
        // User-defined `threadTags` ids. NOT `tags` — that column holds
        // system-assigned source labels ("chat", "telegram", ...).
        tagIds: v.optional(v.array(v.string())),
        tags: v.optional(v.array(v.string())),
        teamId: v.optional(v.string()),
        title: v.optional(v.string()),
        titleVectorId: v.optional(v.string()),
        updatedAt: v.optional(v.number()),
        userId: v.optional(v.string()),
        // User turns on the thread, kept by the messages triggers (`agent/thread-search-triggers.ts`): the palette's turn gate reads it.
        userTurnCount: v.optional(v.number()),
        // Which sources may dispatch to this lead's workers; unset = the lead and the user.
        workerPolicy: v.optional(vWorkerPolicy),
    })
        .shardBy("userId")
        // The usage backfill's walk (`usage/backfill.ts`): a key no thread edit
        // moves, so a thread archived or restored mid-walk is neither skipped
        // nor seen twice.
        .index("by_userId", ["userId"])
        .index("by_user_and_status", ["userId", "status", "deleted"])
        // The sidebar page: newest created first.
        .index("by_user_and_status_createdAt", ["userId", "status", "deleted", "createdAt"])
        .index("by_user_and_pinned", ["userId", "pinnedAt"])
        .index("by_publicAccessToken", ["publicAccessToken"])
        .index("by_user_and_pinned_deleted", ["userId", "deleted", "pinnedAt"])
        .index("by_projectId", ["projectId"])
        .index("by_user_and_organization", ["userId", "organizationId"])
        .index("by_user_and_team", ["userId", "teamId"])
        .index("by_userId_externalThreadId", ["userId", "externalThreadId"])
        .index("by_user_and_order", ["userId", "order"])
        // Home's "recent threads" and the Daily Brief's "threads touched since".
        .index("by_user_and_updatedAt", ["userId", "updatedAt"])
        .index("by_user_and_organization_and_updatedAt", ["userId", "organizationId", "updatedAt"])
        .searchIndex("title", { field: "title", filterFields: ["userId"] })
        .searchIndex("summary", { field: "summary", filterFields: ["userId"] })
        .triggers((t) => threadSearchTriggers(t))
        .relations((r) => {
            return {
                access: r.many("threadAccess", { field: "threadId" }),
                documents: r.many("documents", { field: "threadId" }),
                invites: r.many("threadInvites", { field: "threadId" }),
                messages: r.many("messages", { field: "threadId" }),
                parentRelationships: r.many("threadRelationships", { field: "parentThreadId" }),
                pins: r.many("threadPins", { field: "threadId" }),
                project: r.one("projects", { field: "projectId" }),
                relationships: r.many("threadRelationships", { field: "threadId" }),
            };
        }),

    // User-defined thread labels. Sharded with `threads` because deleting a tag
    // strips its id from the owner's threads in the same mutation.
    threadTags: defineTable({
        // `THREAD_TAG_COLORS` from `chat/tags/logic.ts`, spelled inline because
        // codegen reads columns only as written here; `chat/tags/functions.ts`
        // pins the two together.
        color: v.union(
            v.literal("gray"),
            v.literal("red"),
            v.literal("orange"),
            v.literal("amber"),
            v.literal("green"),
            v.literal("teal"),
            v.literal("blue"),
            v.literal("violet"),
            v.literal("pink"),
        ),
        createdAt: v.number(),
        name: v.string(),
        order: v.number(),
        updatedAt: v.number(),
        userId: v.string(),
    })
        .shardBy("userId")
        .index("by_user_and_order", ["userId", "order"]),

    threadVariables: defineTable({
        threadId: v.string(),
        updatedAt: v.number(),
        userId: v.string(),
        variables: v.array(v.object({ name: v.string(), value: v.string() })),
        // The names of the values an admin acting as the user changed or added, and kept (`prompts/functions.ts#markedNames`):
        // filled into a prompt, such a value marks the draft (`impersonated`).
        variablesByImpersonator: v.optional(v.array(v.string())),
    })
        .shardBy("userId")
        .index("by_thread", ["threadId"])
        .index("by_user", ["userId"]),

    /**
     * One row per `tool-approval-request` the agent paused on. `config` is a
     * snapshot of the run that paused (`chat/lib/tool-run-config.ts`), so the
     * post-approval continuation (`continueAfterToolApproval` in
     * `chat/execute.ts`) resumes with exactly the same model, tools, MCP servers
     * and instructions instead of re-deriving them. The status
     * transition `pending -> approved|denied` is what makes answering idempotent.
     */
    toolApprovalRuns: defineTable({
        approvalId: v.string(),
        config: vToolRunConfig,
        createdAt: v.number(),
        // The pause the request was asked in: the first request's id, shared by every row of that pause. Absent on rows written before
        // it existed, which the reminder groups by creation time instead.
        pauseId: v.optional(v.string()),
        // When the one reminder push for this pending request went out (`lib/approval-reminder.ts`). Absent until it does.
        reminderSentAt: v.optional(v.number()),
        resolvedAt: v.optional(v.number()),
        resolvedBy: v.optional(v.string()),
        // Whether the request is a `requestSecret` card (false: a plain approval or a question). Absent on rows written before it
        // existed, which `discardPausedThreadSecrets` classifies from the saved messages instead.
        secretRequest: v.optional(v.boolean()),
        status: v.union(v.literal("pending"), v.literal("approved"), v.literal("denied")),
        streamId: v.optional(v.string()),
        threadId: v.string(),
        userId: v.string(),
    })
        .shardBy("userId")
        .index("by_approvalId", ["approvalId"])
        .index("by_threadId", ["threadId"])
        // Auto-archive's "does this thread still wait on a person" (`agent/auto-archive.ts`).
        .index("by_threadId_status_createdAt", ["threadId", "status", "createdAt"])
        .index("by_status_createdAt", ["status", "createdAt"])
        .index("by_status_resolvedAt", ["status", "resolvedAt"])
        // The home dashboard's "needs you" (`home/overview.ts`).
        .index("by_userId_status_createdAt", ["userId", "status", "createdAt"]),

    triggerExecutions: defineTable({
        completedAt: v.optional(v.number()),
        error: v.optional(v.string()),
        // The firing of an event trigger that started this run (its `eventState.firedAt`); absent on every other run, a manual one included.
        // A moment in time is switched off only by the run of its own firing (`switchOffFiredMoment`).
        firing: v.optional(v.number()),
        // With `pausedTrigger`: the run failed in a way no later run can cure (its owner left the organization), so a
        // re-sent pause notice gives that cause, not a streak of failures.
        pausedPermanently: v.optional(v.boolean()),
        // Set on the run whose failure paused its trigger, so a redelivered settlement re-sends the pause notice rather than the plain one.
        pausedTrigger: v.optional(v.boolean()),
        payload: v.optional(v.string()),
        // The text the agent was given (the rendered Input Template for a webhook, hidden characters removed), cut to 2,000 characters.
        // Set when the run settles.
        prompt: v.optional(v.string()),
        // When the saved prompt is cleared (`pruneExpiredRunPrompts`): 28 days after the run settled. Set with the prompt.
        promptExpiresAt: v.optional(v.number()),
        startedAt: v.number(),
        // "filtered": a run that was skipped and ran nothing: a verified delivery whose payload failed the
        // trigger's filters, or a quiet routine's scheduled run with nothing to report. `error` holds the reason.
        status: v.union(v.literal("running"), v.literal("completed"), v.literal("failed"), v.literal("filtered")),
        threadId: v.optional(v.string()),
        triggerId: v.id("triggers"),
    })
        .index("by_triggerId_startedAt", ["triggerId", "startedAt"])
        // Finds a trigger's one "filtered" row however many runs followed it (`recordFilteredExecution`).
        .index("by_triggerId_status", ["triggerId", "status"])
        // Finds the prompts past their expiry, so the sweep never rescans rows it already cleared.
        .index("by_promptExpiresAt", ["promptExpiresAt"]),

    triggers: defineTable({
        // Set when the routine belongs to a bot: the run uses the bot's model and instructions.
        // With `botComputer` too, the run may use the bot's shell and file tools (scheduled routines only).
        botComputer: v.optional(v.boolean()),
        botId: v.optional(v.id("bots")),
        createdAt: v.number(),
        cronExpression: v.optional(v.string()),
        description: v.optional(v.string()),
        enabled: v.boolean(),
        // When the owner last turned the trigger on from off; a run that started earlier is not counted toward the failure streak.
        enabledAt: v.optional(v.number()),
        eventConnectionId: v.optional(v.string()),
        eventFilter: v.optional(v.string()),
        eventProvider: v.optional(v.string()),
        // Event triggers: the condition that is watched, and what the last check left behind (`triggers/events.ts`).
        eventSource: v.optional(vEventSource),
        eventState: v.optional(vEventState),
        eventType: v.optional(v.string()),
        // Consecutive runs that failed for a reason the owner can fix; absent = 0. Enough of them pause the trigger (`triggers/failure-streak.ts`).
        failureStreak: v.optional(v.number()),
        // Webhook triggers: every filter must match the JSON body for a delivery to run (`triggers/filters.ts`).
        filters: v.optional(
            v.array(
                v.object({
                    op: v.union(
                        v.literal("equals"),
                        v.literal("not_equals"),
                        v.literal("contains"),
                        v.literal("starts_with"),
                        v.literal("exists"),
                        v.literal("not_exists"),
                    ),
                    path: v.string(),
                    value: v.optional(v.string()),
                }),
            ),
        ),
        inputTemplate: v.optional(v.string()),
        lastError: v.optional(v.string()),
        // Start time of the latest run that succeeded; a run that began earlier no longer counts toward the failure streak.
        lastSuccessStartedAt: v.optional(v.number()),
        lastTriggeredAt: v.optional(v.number()),
        model: v.string(),
        name: v.string(),
        nextTriggerAt: v.optional(v.number()),
        organizationId: v.optional(v.string()),
        payloadTemplate: v.optional(v.string()),
        // A bot routine that only posts when there is something to report (`triggers/quiet.ts`). Absent = off. Only with a botId.
        quietWhenEmpty: v.optional(v.boolean()),
        searchMode: v.optional(v.string()),
        systemPrompt: v.optional(v.string()),
        timezone: v.optional(v.string()),
        triggerCount: v.number(),
        type: v.union(v.literal("schedule"), v.literal("webhook"), v.literal("event")),
        updatedAt: v.number(),
        userId: v.string(),
        // The secret a rotation replaced, still accepted until `webhookPreviousSecretExpiresAt` (an opt-in overlap; `triggers/http.ts`).
        webhookPreviousSecret: v.optional(v.string()),
        webhookPreviousSecretExpiresAt: v.optional(v.number()),
        webhookSecret: v.optional(v.string()),
        // How a webhook delivery is signed; unset = "timestamped" (`triggers/http.ts`).
        // A trigger accepts only its own scheme's headers. Widening this union is additive.
        webhookSignatureScheme: v.optional(vWebhookSignatureScheme),
    })
        .shardBy("userId")
        .index("by_userId_organizationId", ["userId", "organizationId"])
        .index("by_type_enabled", ["type", "enabled"])
        .index("by_enabled_nextTriggerAt", ["enabled", "nextTriggerAt"])
        // The active-watcher cap counts one user's switched-on event triggers; the dispatcher reads the due ones in order. Both stop at a bound.
        .index("by_userId_type_enabled", ["userId", "type", "enabled"])
        .index("by_type_enabled_nextTriggerAt", ["type", "enabled", "nextTriggerAt"]),

    twoFactor: defineTable({
        backupCodes: v.string(),
        // better-auth 1.7.3 brute-force lockout: failed code attempts and the
        // time the lock lifts. Both optional; better-auth defaults the count to 0.
        failedVerificationCount: v.optional(v.number()),
        lockedUntil: v.optional(v.number()),
        secret: v.string(),
        userId: v.string(),
        // Unset on rows from before 1.7.3, which better-auth reads as verified.
        verified: v.optional(v.boolean()),
    })
        .externallyManaged()
        .global()
        .index("userId", ["userId"])
        .triggers((t) => auditTriggersFor(t, "twoFactor", AUDIT_TABLES["twoFactor"]!)),

    // Per-day usage rollup behind the usage page's activity heatmap and skill
    // breakdown (`usage/activity.ts`). Written once per reply — one `__total__`
    // row per day, one row per (day, skill), and one `__project__` row per
    // (day, project) when the reply's thread is in a project.
    // One per user: the resumable walk that fills `usageDaily` from the replies
    // written before the rollup existed (`usage/backfill.ts`).
    usageBackfill: defineTable({
        finishedAt: v.optional(v.number()),
        // The last `order` fully walked in `threadId`; unset = from its start.
        lastOrder: v.optional(v.number()),
        // Past it the next step picks the job up again (a chain that died).
        leaseUntil: v.number(),
        // Replies the walk added to the rollup.
        replies: v.number(),
        // Steps check it, so a restarted walk ends the chain it replaced.
        runId: v.string(),
        // Replies created from here on are the live path's (`recordReplyUsage`).
        startedAt: v.number(),
        status: v.union(v.literal("running"), v.literal("done")),
        // Pagination cursor for the thread AFTER `threadId`.
        threadCursor: v.optional(v.string()),
        threadId: v.optional(v.string()),
        updatedAt: v.number(),
        userId: v.string(),
    })
        .shardBy("userId")
        .index("by_userId", ["userId"]),

    usageDaily: defineTable({
        costMicrodollars: v.number(),
        // The user's calendar day (their time zone when the reply landed), YYYY-MM-DD.
        date: v.string(),
        // The project the reply's thread was in when it was recorded; set only on `__project__` rows.
        projectKey: v.optional(v.string()),
        replies: v.number(),
        // `__total__`, `__project__`, `__assistant__`, a skill id, or `draft:<slug>`. See `usage/activity-logic.ts`.
        skillKey: v.string(),
        skillName: v.optional(v.string()),
        tokens: v.number(),
        updatedAt: v.number(),
        userId: v.string(),
    })
        .shardBy("userId")
        .index("by_user_skill_date", ["userId", "skillKey", "date"])
        .index("by_user_date", ["userId", "date"])
        // One project's rows (the project settings' totals, and the project rows' upsert).
        .index("by_user_project_date", ["userId", "projectKey", "date"])
        // The retention sweep (`gdpr/retention.ts`), which serves a whole shard.
        .index("by_date", ["date"]),

    // The export's pieces: one per rows page, projects page and title or verification step of a run. The export's clear step
    // removes them after the usage object, and the sweep and erasure remove the rest.
    usageExportPieces: defineTable({
        // The user's backfill row when the rows were read: a change to it during the export means history was written meanwhile.
        backfill: v.optional(v.string()),
        bytes: v.number(),
        // The same rows' totals: a backfill can patch a closed day's row without adding one, and the totals catch that.
        closed: v.optional(v.object({ cost: v.number(), replies: v.number(), rows: v.number(), tokens: v.number() })),
        // Rows of the page dated before the cutoff, which the recount of the pass must match.
        closedRows: v.optional(v.number()),
        // When the piece was written. The sweep does not read it: a run's pieces go at the run's `deleteAt`.
        createdAt: v.optional(v.number()),
        // The day the export's recount is taken before (YYYY-MM-DD): rows dated before it are counted, later ones are not.
        cutoff: v.optional(v.string()),
        // `titles` is no longer written; it stays in the union so stored rows still fit the blessed schema baseline.
        kind: v.union(v.literal("projects"), v.literal("rows"), v.literal("titles"), v.literal("verified")),
        // The rows page's cursor for the next page (unset on the last page).
        nextCursor: v.optional(v.string()),
        pass: v.number(),
        // The exported JSON of the piece: rows, or a map of project id to a title and its grant.
        payload: v.string(),
        // The rows page's distinct project ids, which the title steps read.
        projectIds: v.array(v.string()),
        // The export run that wrote the piece, `<request id>:<workflow instance id>`: a run reads and clears only its own.
        requestId: v.string(),
        // Rows the piece holds, or titles it names.
        rowCount: v.number(),
        // The page's (or the group's) order within its pass and kind.
        seq: v.number(),
        userId: v.string(),
    })
        .shardBy("userId")
        .index("by_userId", ["userId"])
        .index("by_createdAt", ["createdAt"])
        // A run's pieces of one pass and kind, in their order: what the usage action reads them by.
        .index("by_request", ["requestId", "pass", "kind", "seq"]),

    // One row per project a pass names, written once per pass: a project on several rows pages is read once. Cleared with the pass.
    usageExportProjects: defineTable({
        pass: v.number(),
        projectId: v.string(),
        requestId: v.string(),
        userId: v.string(),
    })
        .shardBy("userId")
        .index("by_userId", ["userId"])
        .index("by_request_project", ["requestId", "pass", "projectId"]),
    // One small row per export run: its key, its owner, when it began, and the key of the usage JSON object it stored, if any. The
    // row is that object's record: kept until the object is confirmed deleted, so the sweep can retry the purge from it. `deleteAt` is
    // the time the sweep next acts on the run: each sweep that finds the run live sets it one time to live ahead, so a dead run's pieces
    // go at that time. A run the account erasure re-armed (`erasingSince`) is checked a minute ahead instead, so its object goes soon after its
    // export ends. A run is stored with its `deleteAt`, so the sweep finds every run. The sweep reads these rows, which hold no payloads.
    usageExportRuns: defineTable({
        createdAt: v.number(),
        deleteAt: v.number(),
        // When the erasure re-armed a live run it could not finish. Such a run is checked a minute ahead while live, for an hour from then.
        erasingSince: v.optional(v.number()),
        requestId: v.string(),
        usageKey: v.optional(v.string()),
        userId: v.string(),
    })
        .shardBy("userId")
        .index("by_createdAt", ["createdAt"])
        .index("by_deleteAt", ["deleteAt"])
        .index("by_userId", ["userId"])
        .index("by_requestId", ["requestId"]),

    // One claimed booking slot per contributor booked under an organization (`usage/cohorts.ts`). The unique slot is the claim: two bookings
    // cannot take the same one. Holds no user, so it carries no one's usage.
    usageOrganizationCohortSlots: defineTable({
        // When the slot was claimed: the organization view counts a cohort sealed only once its last slot has settled (`SLOT_SETTLE_MS`).
        claimedAt: v.number(),
        // Set once the slot's contributor row has landed: a cohort is sealed only when each of its slots is (`sealedCohortsOf`).
        filled: v.optional(v.literal(true)),
        organizationId: v.string(),
        slot: v.number(),
    })
        .global()
        .index("by_organization_and_slot", ["organizationId", "slot"], { unique: true }),

    // Everyone with ledger rows under an organization, whether or not they are still a member: the organization view lists these, so a
    // member who leaves keeps counting. Global, so the live path, the view and erasure reach it from any shard.
    usageOrganizationContributors: defineTable({
        // The stable cohort the contributor was booked into (`usage/cohorts.ts`); it never changes once set.
        cohort: v.number(),
        createdAt: v.number(),
        // Set while a guest's merge into this account runs (`lib/account-merge.ts#handOverOrganizationContributors`): the guest whose entry,
        // and cohort, this became, so the merge moves that guest's closed-week ledger rows with it. Cleared once the merge has moved them.
        mergedFrom: v.optional(v.string()),
        organizationId: v.string(),
        userId: v.string(),
    })
        .global()
        // Unique: a member has one entry under an organization, so two first replies booked at once cannot place them in two cohorts.
        .index("by_organization_and_user", ["organizationId", "userId"], { unique: true })
        .index("by_organization_and_cohort", ["organizationId", "cohort", "userId"])
        // The entry a merging guest was handed over to: the guest is not booked again while the merge runs (`insertContributor`).
        .index("by_organization_and_merged_from", ["organizationId", "mergedFrom"])
        .index("by_user", ["userId"]),

    // One row per reply filed under a project the user's organization owns, when the reply is recorded. The organization view sums
    // these by instant, so a project moved into an organization later does not expose its earlier usage, and a reply stays with the
    // organization it was recorded under. Sharded with the member, so erasure and the member's view read the member's shard.
    usageOrganizationReplies: defineTable({
        // The reply's instant (epoch ms), as recorded.
        at: v.number(),
        costMicrodollars: v.number(),
        // Set by a guest merge (`lib/account-merge.ts#importShardRows`) on a guest's row of a week the view may already show that could not
        // move into the cohort that counted it: the guest whose row it was. The row stays the account's record (export, erasure, retention
        // prune by `at`), and the organization view and the contributor reconcile never read it, so no released week changes by it.
        heldFrom: v.optional(v.string()),
        organizationId: v.string(),
        projectKey: v.string(),
        replyKey: v.string(),
        tokens: v.number(),
        userId: v.string(),
    })
        .shardBy("userId")
        .index("by_organization_and_at", ["organizationId", "at"])
        // The retention sweep (`gdpr/retention.ts`), which reads a shard's rows by age.
        .index("by_at", ["at"])
        .index("by_user_and_reply", ["userId", "replyKey"]),
    // The replies already in `usageDaily`, keyed by the reply's first row id:
    // what makes `recordReplyUsage` and the backfill count a reply once.
    // Pruned by `usage/backfill.ts#sweepUsageRollup` once the backfill is done.
    usageReplies: defineTable({
        // Set by a retry's record that arrived more than a day after the reply with no key to find: the reply's total is
        // still to come, from its first record, which counts it with `deferredProjectKey` (`usage/activity.ts`).
        awaitingTotal: v.optional(v.boolean()),
        deferredProjectKey: v.optional(v.string()),
        recordedAt: v.number(),
        replyKey: v.string(),
        userId: v.string(),
        // Set when the reply was counted while its project could not be read (`usage/activity.ts`): a retry of its
        // record still files the project, once, and clears it.
        withoutProject: v.optional(v.boolean()),
    })
        .shardBy("userId")
        .index("by_user_reply", ["userId", "replyKey"])
        // The prune, which serves a whole shard.
        .index("by_recordedAt", ["recordedAt"]),

    user: defineTable({
        banExpires: v.optional(v.number()),
        banned: v.optional(v.boolean()),
        banReason: v.optional(v.string()),
        /** The user's OWN plan — Pro is bought per user (`billing/`); an organization's Team plan is `organization.baseTier`. */
        baseTier: v.optional(v.union(v.literal("free"), v.literal("pro"))),
        createdAt: v.number(),
        /** Set by the Creem webhook for the user's Pro subscription; the portal opens on it. */
        creemCustomerId: v.optional(v.string()),
        /** The Creem subscription that set `baseTier`; a cancel of any other one leaves it alone. */
        creemSubscriptionId: v.optional(v.string()),
        email: v.string(),
        /** `@lunora/auth`'s case- and Unicode-folded copy of `email`, added to the user table by its plugin. */
        emailCanonical: v.optional(v.string()),
        emailVerified: v.boolean(),
        image: v.optional(v.string()),
        isAnonymous: v.optional(v.boolean()),
        name: v.string(),
        role: v.optional(v.string()),
        twoFactorEnabled: v.optional(v.boolean()),
        updatedAt: v.number(),
        userId: v.optional(v.string()),
    })
        .global()
        // Unique: `@lunora/auth` relies on it to reject a concurrent sign-up that repeats a folded address.
        .index("emailCanonical", ["emailCanonical"], { unique: true })
        .index("email_name", ["email", "name"])
        .index("name", ["name"])
        .index("role", ["role"])
        .index("userId", ["userId"])
        .index("by_isAnonymous", ["isAnonymous"])
        .triggers((t) => auditTriggersFor(t, "user", AUDIT_TABLES["user"]!)),

    // A user's grant for one connector. `encryptedTokens` is the access/refresh
    // pair as ONE ciphertext (`connectors/lib/token-crypto.ts`); `oauthClient`
    // is how to refresh and revoke it. `kvTokenKey` is the retired proxy-Worker
    // design and is no longer written.
    userConnectors: defineTable({
        accountLabel: v.optional(v.string()),
        connectedAt: v.number(),
        connectorDefinitionId: v.id("connectorDefinitions"),
        encryptedTokens: v.optional(v.string()),
        /** Whether `encryptedTokens` holds a refresh token — lets reads tell "expired" from "refreshable" without decrypting. */
        hasRefreshToken: v.optional(v.boolean()),
        kvTokenKey: v.optional(v.string()),
        lastError: v.optional(v.string()),
        lastUsedAt: v.optional(v.number()),
        metadata: v.optional(v.any()),
        oauthClient: v.optional(vOAuthClientRecord),
        organizationId: v.optional(v.string()),
        scopes: v.array(v.string()),
        status: v.union(v.literal("connected"), v.literal("disconnected"), v.literal("expired"), v.literal("error")),
        tokenExpiresAt: v.optional(v.number()),
        userId: v.string(),
    })
        .shardBy("userId")
        .index("by_user_and_definition", ["userId", "connectorDefinitionId"])
        .index("by_organization", ["organizationId"])
        .index("by_status", ["status"])
        .index("by_connectorDefinitionId", ["connectorDefinitionId"])
        .relations((r) => {
            return {
                definition: r.one("connectorDefinitions", { field: "connectorDefinitionId" }),
            };
        }),

    userSettings: defineTable({
        aboutMe: v.optional(v.string()),
        // Appearance presets (accepted values: `auth/fields.ts`).
        accentColor: v.optional(v.string()),
        // Auto-archive threads idle this many days (`agent/auto-archive.ts`). Absent or 0 = off; 7-365 otherwise.
        autoArchiveAfterDays: v.optional(v.number()),
        // Archive a chat when a pull request it is linked to merges (`agent/auto-archive.ts#archiveMergedThread`). Absent = off.
        autoArchiveMergedChats: v.optional(v.boolean()),
        // When the owner last turned `autoArchiveMergedChats` on (set by the settings write, never by the client). Only a merge at or
        // after it archives a chat: a merge from before the opt-in, first seen after it, does not.
        autoArchiveMergedChatsSince: v.optional(v.number()),
        // Compact a thread's model context before a reply once it fills this percentage of the model's window (`agent/thread-compaction.ts`). Absent or 0 = off; 50-95 otherwise.
        autoCompactThreshold: v.optional(v.number()),
        // Opt-in: speak every finished reply aloud (`features/chat/voice-mode`). Absent = off.
        autoReadReplies: v.optional(v.boolean()),
        // The single backup model saved before `backupModels`, read only while that list is absent (`chat/lib/backup-model.ts#storedBackupModels`).
        backupModel: v.optional(v.string()),
        // Models a reply is retried on, in order, when the chosen model fails with an infrastructure error (`chat/lib/backup-model.ts`). Empty = none; absent = `backupModel`.
        backupModels: v.optional(v.array(v.string())),
        // Appearance: cap long chat code blocks (absent = on). Accepted values: `auth/fields.ts`.
        capLongCodeBlocks: v.optional(v.boolean()),
        // In-app toasts for chat events (`features/notifications/lib/chat-toasts.ts`). Absent = on.
        chatFailedToastEnabled: v.optional(v.boolean()),
        chatFinishedToastEnabled: v.optional(v.boolean()),
        chatInputToastEnabled: v.optional(v.boolean()),
        codeFont: v.optional(v.string()),
        codeHighlightTheme: v.optional(v.string()),
        codeLineNumbers: v.optional(v.boolean()),
        // Opt-in composer ghost-text completions (`chat/autocomplete.ts`). Absent = off.
        composerAutocompleteEnabled: v.optional(v.boolean()),
        // Opt-in Vim keys in the chat composer. Absent = off.
        composerVimMode: v.optional(v.boolean()),
        // Ask before a chat is archived, deleted or unpinned in the web app. Archive and unpin: absent = off; delete: absent = on.
        confirmBeforeArchiveChat: v.optional(v.boolean()),
        confirmBeforeDeleteChat: v.optional(v.boolean()),
        confirmBeforeUnpinChat: v.optional(v.boolean()),
        // Appearance: contrast mode (accepted values: `auth/fields.ts`). Absent = follow the system.
        contrast: v.optional(v.string()),
        customInstructions: v.optional(v.string()),
        // Opt-in morning summary (`notifications/daily-brief.ts`). Absent = off.
        dailyBriefEnabled: v.optional(v.boolean()),
        // When the user answered "Not now" to the home page's one-time Daily Brief offer (`home/overview.ts`). Server-written only. Absent = not answered.
        dailyBriefOfferDismissedAt: v.optional(v.number()),
        // The permission mode a new chat starts with (`chat/lib/thread-permission-mode.ts`). Absent = auto.
        defaultPermissionMode: v.optional(v.union(v.literal("supervised"), v.literal("auto"), v.literal("full"))),
        // Appearance: UI spacing preset (accepted values: `auth/fields.ts`).
        density: v.optional(v.string()),
        dictationLanguage: v.optional(v.string()),
        disableExternalLinkWarning: v.optional(v.boolean()),
        enableFollowupSuggestions: v.optional(v.boolean()),
        favoriteModels: v.optional(v.array(v.string())),
        // A message sent while a reply streams joins that reply at its next step, instead of queueing behind it. Absent = queue.
        followUpSteer: v.optional(v.boolean()),
        hidePersonalInfo: v.optional(v.boolean()),
        // A message sent during a coding agent's turn interrupts that turn and goes next, instead of queueing behind it. Absent = queue.
        hostFollowUpSteer: v.optional(v.boolean()),
        isAdvancedUser: v.optional(v.boolean()),
        // Keep an idle chat out of auto-archive while it has a linked pull request that is open (`agent/auto-archive.ts`). Absent = on.
        keepOpenPullRequestChats: v.optional(v.boolean()),
        keyboardShortcuts: v.optional(v.any()),
        language: v.optional(v.string()),
        lastChatId: v.optional(v.string()),
        location: v.optional(v.string()),
        mainFont: v.optional(v.string()),
        memoryEnabled: v.optional(v.boolean()),
        mermaidTheme: v.optional(v.string()),
        // The user's own names for models, model id → nickname (`auth/lib/model-nicknames.ts`). Absent = none.
        modelNicknames: v.optional(v.record(v.string(), v.string())),
        // New composer chats are temporary by default. Absent = off.
        newChatsTemporary: v.optional(v.boolean()),
        nickname: v.optional(v.string()),
        onboardingCompleted: v.optional(v.boolean()),
        // Set when an admin acting as the user wrote a personalization field that reaches the system prompt
        // (`auth/lib/personalization.ts`), and kept: a run with it gets no saved login. Server-written only.
        personalizationByImpersonator: v.optional(v.literal(true)),
        profession: v.optional(v.string()),
        // The runner a new thread in each organization project starts on for this person, keyed by project id (`acp/lib/project-runner.ts`). Written server-side only, at most 200 projects.
        projectRunnerDefaults: v.optional(
            v.record(
                v.string(),
                v.object({
                    agentKey: v.string(),
                    deviceId: v.string(),
                    folderId: v.string(),
                    threadAt: v.optional(v.number()),
                    threadId: v.optional(v.string()),
                }),
            ),
        ),
        // A reply paused by a provider's usage limit resumes by itself when the limit resets. Absent = on (`chat/lib/usage-limit-settings.ts`).
        resumeAfterUsageLimit: v.optional(v.boolean()),
        // A run whose worker died resumes from its last saved row, up to 3 times per reply (`chat/streaming/persistent/interrupted.ts`). Absent = on.
        resumeInterruptedRuns: v.optional(v.boolean()),
        // Opt-in: opening /chat lands on the most recent thread. Absent = off.
        resumeLastChat: v.optional(v.boolean()),
        // Opt-in: suggest scheduled tasks drawn from the user's own messages (`tasks/suggestions.ts`). Absent = off.
        scheduleIdeasEnabled: v.optional(v.boolean()),
        // Hostnames the web search tool never returns (`chat/tools/search-domains.ts`). Absent = none.
        searchDomainBlocklist: v.optional(v.array(v.string())),
        sendBehavior: v.optional(v.string()),
        // First-run setup steps the user skipped (`auth/setup-steps.ts`): "pair" | "ssh" | "agent". At most 8, capped by `auth/lib/setup-step-limits.ts`. Absent = none.
        setupStepsSkipped: v.optional(v.array(v.string())),
        // A chat whose reply is paused by a usage limit is snoozed until the reset time. Absent = off.
        snoozeUntilUsageLimitReset: v.optional(v.boolean()),
        // A model and instructions per kind of delegated work (`sub-agents/roles.ts`).
        subAgentRoles: v.optional(vSubAgentRoles),
        // Opt-in email when a task or trigger run finishes with a result (`notifications/task-email.ts`). Absent = off.
        taskEmailEnabled: v.optional(v.boolean()),
        temporaryChatRetentionHours: v.optional(v.number()),
        // Summaries of a long thread's older turns, made while it sits idle (`agent/thread-summaries.ts`). OPT-IN: absent means off.
        threadSummariesEnabled: v.optional(v.boolean()),
        // How the user wants thread titles worded; appended to the title prompt (`chat/functions.ts#createTitleChat`). Blank or absent = none.
        threadTitleInstructions: v.optional(v.string().max(MAX_THREAD_TITLE_INSTRUCTIONS_LENGTH)),
        timezone: v.optional(v.string()),
        userId: v.string(),
        // Default voice for spoken replies (`voice/speech.ts`); a skill's own voice wins. Absent = the model's default.
        voiceModeVoice: v.optional(v.string()),
    })
        .shardBy("userId")
        .index("by_userId", ["userId"])
        .triggers((t) => auditTriggersFor(t, "userSettings", AUDIT_TABLES["userSettings"]!)),

    userSkills: defineTable({
        addedAt: v.number(),
        autoRun: v.optional(v.boolean()),
        enabled: v.boolean(),
        skillId: v.id("skills"),
        userId: v.string(),
    })
        .shardBy("userId")
        .index("by_user_and_skill", ["userId", "skillId"])
        .index("by_user_and_enabled", ["userId", "enabled"])
        .index("by_skillId", ["skillId"])
        .relations((r) => {
            return {
                skill: r.one("skills", { field: "skillId" }),
            };
        }),

    userVariableDefaults: defineTable({
        organizationId: v.optional(v.string()),
        updatedAt: v.number(),
        userId: v.string(),
        variables: v.array(v.object({ name: v.string(), value: v.string() })),
        // The names of the values an admin acting as the user changed or added, and kept (`prompts/functions.ts#markedNames`):
        // filled into a prompt, such a value marks the draft (`impersonated`).
        variablesByImpersonator: v.optional(v.array(v.string())),
        // A fresh id from every write of the values or marks (`updatedAt` can repeat within a millisecond): a "Keep as mine"
        // clears a mark only while it is still the one read (`clearDefaultsMark`). Absent on a row no such write has had yet.
        writeId: v.optional(v.string()),
    })
        // `.global()`, not `.shardBy("userId")`: read across users.
        .global()
        .index("by_organization", ["organizationId"])
        .index("by_user_and_organization", ["userId", "organizationId"]),

    verification: defineTable({
        createdAt: v.number(),
        expiresAt: v.number(),
        identifier: v.string(),
        updatedAt: v.number(),
        value: v.string(),
    })
        .externallyManaged()
        .global()
        .index("expiresAt", ["expiresAt"])
        .index("identifier", ["identifier"])
        .triggers((t) => auditTriggersFor(t, "verification", AUDIT_TABLES["verification"]!)),

    // Develop mode: a repository the user chose to keep fresh (`source-control/freshness.ts`). One row per
    // user and repository holds the list cache (the open, non-draft pull requests that ask the user for a review),
    // its ETag, and the poll schedule. `nextPollAt` > 0 is the lease or the next poll the shard tick reads (0 never
    // armed); `leasedAt` stamps the poll in flight, and a result is applied only while it still matches. `dirtyAt`
    // is all a webhook ever writes. The webhook secret is encrypted and is never returned.
    watchedRepositories: defineTable({
        checkedAt: v.number(),
        createdAt: v.number(),
        dirtyAt: v.number(),
        etag: v.union(v.string(), v.null()),
        hostOrigin: v.string(),
        lastStatus: vPollStatus,
        leasedAt: v.number(),
        login: v.union(v.string(), v.null()),
        nextPollAt: v.number(),
        repository: v.string(),
        requested: v.array(vCachedRequest),
        // False until the first successful poll: that one is the baseline and notifies nothing.
        seeded: v.boolean(),
        userId: v.string(),
        webhookSecret: v.optional(v.string()),
        webhookSeenAt: v.number(),
    })
        .shardBy("userId")
        .index("by_nextPollAt", ["nextPollAt"])
        .index("by_user_and_repository", ["userId", "hostOrigin", "repository"]),

    workflowExecutions: defineTable({
        completedAt: v.optional(v.number()),
        error: v.optional(v.string()),
        projectId: v.id("projects"),
        startedAt: v.optional(v.number()),
        status: v.union(v.literal("pending"), v.literal("running"), v.literal("completed"), v.literal("failed"), v.literal("cancelled")),
        totalUsage: v.optional(v.object({ completionTokens: v.number(), promptTokens: v.number(), totalTokens: v.number() })),
        userId: v.string(),
        workflowSnapshot: v.optional(v.any()),
    })
        .shardBy("userId")
        .index("by_user", ["userId"])
        .index("by_status", ["status"])
        .index("by_project_and_status", ["projectId", "status"]),

    workflowPresence: defineTable({
        cursorPosition: v.optional(v.union(v.object({ x: v.number(), y: v.number() }), v.null())),
        editingNodeId: v.optional(v.string()),
        lastHeartbeat: v.number(),
        projectId: v.id("projects"),
        selectedNodeId: v.optional(v.string()),
        sessionId: v.string(),
        userColor: v.string(),
        userId: v.string(),
        userName: v.string(),
        viewportCenter: v.optional(v.union(v.object({ x: v.number(), y: v.number(), zoom: v.number() }), v.null())),
    })
        .shardBy("userId")
        .index("by_project_and_user", ["projectId", "userId"])
        .index("by_session", ["sessionId"])
        .index("by_heartbeat", ["lastHeartbeat"])
        .index("by_userId", ["userId"]),
    workflowVersions: defineTable({
        content: v.optional(
            v.object({
                edges: v.array(
                    v.object({
                        id: v.string(),
                        source: v.string(),
                        sourceHandle: v.optional(v.string()),
                        target: v.string(),
                        targetHandle: v.optional(v.string()),
                        type: v.optional(v.string()),
                    }),
                ),
                nodes: v.array(v.object({ data: v.any(), id: v.string(), position: v.object({ x: v.number(), y: v.number() }), type: v.string() })),
                viewport: v.optional(v.object({ x: v.number(), y: v.number(), zoom: v.number() })),
            }),
        ),
        label: v.optional(v.string()),
        projectId: v.id("projects"),
        userId: v.string(),
    })
        .shardBy("userId")
        .index("by_project", ["projectId"])
        .index("by_userId", ["userId"]),
})
    // The `@lunora/payment` store's tables (`payment_customers`, `payment_events`,
    // `payment_referenceRevisions`, `payment_sessions`, `payment_subscriptions`,
    // `payment_usageEvents`), owned by
    // the billing module. Merged, never copied: the store reads and writes them by
    // these names, which the package may change on any upgrade.
    .extend(paymentExtension)
    // Pins every Durable Object (shards, scheduler, shard registry) to the EU. Codegen reads
    // this argument as a string literal, so it cannot follow `DATA_JURISDICTION`
    // (`lib/data-jurisdiction.ts`); `data-jurisdiction.test.ts` pins that it stays "eu", the
    // setting's default. A DO's jurisdiction is fixed at creation.
    .jurisdiction("eu");

export default schema;
