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
import { defineSchema, defineTable, v } from "lunorash/server";

import { vGroupChat } from "./chat/group/validators";
import { vToolRunConfig } from "./chat/lib/tool-run-config";
import { vCodingAgentAssignment, vCodingAgentId, vCodingAgentRunStatus } from "./coding-agents/validators";
import { vOAuthClientRecord, vOAuthFlow, vOAuthTarget } from "./connectors/lib/validators";
import { vDeviceCallPhase, vDeviceCallStatus, vDeviceManifestTool, vDevicePlatform, vDeviceTaintSource } from "./devices/validators";
import { embed } from "./embed";
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
import { notificationInputFields } from "./notifications/validators";
import { vSkillConfig } from "./skills/validators";
import { vSubAgentRunStatus } from "./sub-agents/validators";
import { vGoalStatus, vTaskRunOrigin, vTaskRunStatus, vTaskStatus, vVerdict } from "./tasks/validators";

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
        autoDetectComplexity: v.optional(v.boolean()),
        autoMediaEnrichment: v.optional(v.boolean()),
        browserSettings: v.optional(
            v.object({ domainAllowlist: v.optional(v.array(v.string())), domainBlocklist: v.optional(v.array(v.string())), enabled: v.optional(v.boolean()) }),
        ),
        customAIProviders: v.optional(v.any()),
        customization: v.optional(v.any()),
        customModels: v.optional(v.any()),
        defaultModels: v.optional(v.any()),
        enableDatasource: v.optional(v.boolean()),
        enableKnowledge: v.optional(v.boolean()),
        enablePlanner: v.optional(v.boolean()),
        generalProviders: v.optional(v.any()),
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

    browserActions: defineTable({
        action: v.union(v.literal("navigate"), v.literal("screenshot"), v.literal("click"), v.literal("type"), v.literal("extract"), v.literal("scroll")),
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

    browserSessions: defineTable({
        completedAt: v.optional(v.number()),
        connectUrl: v.optional(v.string()),
        currentUrl: v.optional(v.string()),
        errorMessage: v.optional(v.string()),
        extensionId: v.optional(v.string()),
        extensionVersion: v.optional(v.string()),
        lastActivityAt: v.number(),
        providerSessionId: v.optional(v.string()),
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
     * Who may attach a `chatFiles` row. The rows are content-addressed and
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

    chatFiles: defineTable({
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
        storageId: v.string(),
    })
        // `.global()`: content-addressed (`agent-files/<sha256>`), so identical
        // bytes stored by two users share ONE R2 object. Its refcount must see
        // every user's references — per-shard copies would each reap the object
        // the other still uses (docs/plans/per-user-sharding.md).
        .global()
        .index("hash_filename", ["hash", "filename"])
        .index("refcount", ["refcount"]),

    chatImportJobs: defineTable({
        completedAt: v.optional(v.number()),
        createdAt: v.number(),
        currentStep: v.optional(v.string()),
        errorMessage: v.optional(v.string()),
        failedConversations: v.optional(v.number()),
        importedConversations: v.number(),
        progress: v.optional(v.number()),
        provider: v.union(v.literal("chatgpt"), v.literal("gemini"), v.literal("claude")),
        r2Key: v.optional(v.string()),
        status: v.union(v.literal("pending"), v.literal("processing"), v.literal("completed"), v.literal("failed")),
        totalConversations: v.number(),
        userId: v.string(),
    })
        .shardBy("userId")
        .index("by_user_and_status", ["userId", "status"]),

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
        threadId: v.id("threads"),
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
    // A paired install of the desktop shell (`devices/`, `apps/native`). The
    // secret signs calls and verifies results; it is removed on revoke, so a
    // revoked row can sign nothing. `manifest` is the device's verified tools.
    devices: defineTable({
        createdAt: v.number(),
        encryptedSecret: v.optional(v.string()),
        lastSeenAt: v.optional(v.number()),
        manifest: v.optional(v.array(vDeviceManifestTool)),
        manifestIssuedAt: v.optional(v.number()),
        name: v.string(),
        platform: vDevicePlatform,
        revokedAt: v.optional(v.number()),
        userId: v.string(),
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

    emails: defineTable({
        email: v.string(),
        expectation: v.union(v.literal("delivered"), v.literal("bounced"), v.literal("complained")),
    })
        .global()
        .index("by_email", ["email"]),

    embeddings_128: defineTable({
        model: v.string(),
        model_table_threadId: v.optional(v.string()),
        model_table_userId: v.optional(v.string()),
        table: v.string(),
        threadId: v.optional(v.string()),
        userId: v.optional(v.string()),
        vector: v.array(v.number()),
    })
        .shardBy("userId")
        .index("by_userId", ["userId"])
        .index("model_table_threadId", ["model", "table", "threadId"])
        .vectorize("vector", {
            dimensions: 128,
            embed,
            index: "embeddings-128",
            metadata: ["model_table_userId", "model_table_threadId"],
            metric: "cosine",
        }),

    embeddings_256: defineTable({
        model: v.string(),
        model_table_threadId: v.optional(v.string()),
        model_table_userId: v.optional(v.string()),
        table: v.string(),
        threadId: v.optional(v.string()),
        userId: v.optional(v.string()),
        vector: v.array(v.number()),
    })
        .shardBy("userId")
        .index("by_userId", ["userId"])
        .index("model_table_threadId", ["model", "table", "threadId"])
        .vectorize("vector", {
            dimensions: 256,
            embed,
            index: "embeddings-256",
            metadata: ["model_table_userId", "model_table_threadId"],
            metric: "cosine",
        }),

    embeddings_512: defineTable({
        model: v.string(),
        model_table_threadId: v.optional(v.string()),
        model_table_userId: v.optional(v.string()),
        table: v.string(),
        threadId: v.optional(v.string()),
        userId: v.optional(v.string()),
        vector: v.array(v.number()),
    })
        .shardBy("userId")
        .index("by_userId", ["userId"])
        .index("model_table_threadId", ["model", "table", "threadId"])
        .vectorize("vector", {
            dimensions: 512,
            embed,
            index: "embeddings-512",
            metadata: ["model_table_userId", "model_table_threadId"],
            metric: "cosine",
        }),

    embeddings_768: defineTable({
        model: v.string(),
        model_table_threadId: v.optional(v.string()),
        model_table_userId: v.optional(v.string()),
        table: v.string(),
        threadId: v.optional(v.string()),
        userId: v.optional(v.string()),
        vector: v.array(v.number()),
    })
        .shardBy("userId")
        .index("by_userId", ["userId"])
        .index("model_table_threadId", ["model", "table", "threadId"])
        .vectorize("vector", {
            dimensions: 768,
            embed,
            index: "embeddings-768",
            metadata: ["model_table_userId", "model_table_threadId"],
            metric: "cosine",
        }),

    embeddings_1024: defineTable({
        model: v.string(),
        model_table_threadId: v.optional(v.string()),
        model_table_userId: v.optional(v.string()),
        table: v.string(),
        threadId: v.optional(v.string()),
        userId: v.optional(v.string()),
        vector: v.array(v.number()),
    })
        .shardBy("userId")
        .index("by_userId", ["userId"])
        .index("model_table_threadId", ["model", "table", "threadId"])
        .vectorize("vector", {
            dimensions: 1024,
            embed,
            index: "embeddings-1024",
            metadata: ["model_table_userId", "model_table_threadId"],
            metric: "cosine",
        }),

    embeddings_1408: defineTable({
        model: v.string(),
        model_table_threadId: v.optional(v.string()),
        model_table_userId: v.optional(v.string()),
        table: v.string(),
        threadId: v.optional(v.string()),
        userId: v.optional(v.string()),
        vector: v.array(v.number()),
    })
        .shardBy("userId")
        .index("by_userId", ["userId"])
        .index("model_table_threadId", ["model", "table", "threadId"])
        .vectorize("vector", {
            dimensions: 1408,
            embed,
            index: "embeddings-1408",
            metadata: ["model_table_userId", "model_table_threadId"],
            metric: "cosine",
        }),

    embeddings_1536: defineTable({
        model: v.string(),
        model_table_threadId: v.optional(v.string()),
        model_table_userId: v.optional(v.string()),
        table: v.string(),
        threadId: v.optional(v.string()),
        userId: v.optional(v.string()),
        vector: v.array(v.number()),
    })
        .shardBy("userId")
        .index("by_userId", ["userId"])
        .index("model_table_threadId", ["model", "table", "threadId"])
        .vectorize("vector", {
            dimensions: 1536,
            embed,
            index: "embeddings-1536",
            metadata: ["model_table_userId", "model_table_threadId"],
            metric: "cosine",
        }),

    embeddings_2048: defineTable({
        model: v.string(),
        model_table_threadId: v.optional(v.string()),
        model_table_userId: v.optional(v.string()),
        table: v.string(),
        threadId: v.optional(v.string()),
        userId: v.optional(v.string()),
        vector: v.array(v.number()),
    })
        .shardBy("userId")
        .index("by_userId", ["userId"])
        .index("model_table_threadId", ["model", "table", "threadId"])
        .vectorize("vector", {
            dimensions: 2048,
            embed,
            index: "embeddings-2048",
            metadata: ["model_table_userId", "model_table_threadId"],
            metric: "cosine",
        }),

    embeddings_3072: defineTable({
        model: v.string(),
        model_table_threadId: v.optional(v.string()),
        model_table_userId: v.optional(v.string()),
        table: v.string(),
        threadId: v.optional(v.string()),
        userId: v.optional(v.string()),
        vector: v.array(v.number()),
    })
        .shardBy("userId")
        .index("by_userId", ["userId"])
        .index("model_table_threadId", ["model", "table", "threadId"])
        .vectorize("vector", {
            dimensions: 3072,
            embed,
            index: "embeddings-3072",
            metadata: ["model_table_userId", "model_table_threadId"],
            metric: "cosine",
        }),

    embeddings_4096: defineTable({
        model: v.string(),
        model_table_threadId: v.optional(v.string()),
        model_table_userId: v.optional(v.string()),
        table: v.string(),
        threadId: v.optional(v.string()),
        userId: v.optional(v.string()),
        vector: v.array(v.number()),
    })
        .shardBy("userId")
        .index("by_userId", ["userId"])
        .index("model_table_threadId", ["model", "table", "threadId"])
        .vectorize("vector", {
            dimensions: 4096,
            embed,
            index: "embeddings-4096",
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
        createdAt: v.number(),
        lastMessageId: v.string(),
        suggestions: v.array(v.string()),
        threadId: v.string(),
        updatedAt: v.number(),
    }).index("by_thread", ["threadId"]),

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
        confidence: v.optional(v.number()),
        embeddingId: v.optional(v.string()),
        importance: v.optional(v.number()),
        // Last time evidence confirmed the memory (a restatement, a reflection
        // merge, a user edit). Unset reads as `updatedAt` — see `memory/taxonomy.ts`.
        lastConfirmedAt: v.optional(v.number()),
        memory: v.string(),
        // Pinned by the user: nightly reflection never decays, retires or merges it away.
        pinned: v.optional(v.boolean()),
        source: v.optional(v.union(v.literal("auto"), v.literal("manual"), v.literal("compressed"), v.literal("reflection"))),
        supersededBy: v.optional(v.id("memories")),
        supersedes: v.optional(v.id("memories")),
        threadId: v.optional(v.id("threads")),
        // The taxonomy — see `memory/taxonomy.ts`.
        type: v.union(v.literal("identity"), v.literal("preference"), v.literal("context"), v.literal("activity"), v.literal("experience")),
        updatedAt: v.optional(v.number()),
        userId: v.optional(v.string()),
        version: v.optional(v.number()),
    })
        .shardBy("userId")
        .index("threadId", ["threadId"])
        .index("embeddingId", ["embeddingId"])
        .index("by_userId_type", ["userId", "type"])
        .index("by_userId_supersededBy", ["userId", "supersededBy"]),

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
        embeddingId: v.optional(v.string()),
        error: v.optional(v.string()),
        fileIds: v.optional(v.array(v.id("chatFiles"))),
        finishReason: v.optional(v.string()),
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
        // `.global()`, not `.shardBy("userId")`: read across users — see
        // docs/plans/per-user-sharding.md.
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
        // `.global()`, not `.shardBy("userId")`: read across users — see
        // docs/plans/per-user-sharding.md.
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
        reasoning: v.optional(v.string()),
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
    })
        .index("by_streamId_seq", ["streamId", "seq"])
        .relations((r) => {
            return {
                stream: r.one("persistentStreams", { field: "streamId" }),
            };
        }),

    persistentStreams: defineTable({
        expiresAt: v.number(),
        messageId: v.string(),
        // Set once, by the ONE run that may write this stream (`claimStreamRun`).
        // The run arrives on the jobs queue, which delivers at least once; a
        // redelivery finds this set and does nothing.
        runClaimedAt: v.optional(v.number()),
        status: v.string(),
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
        userId: v.string(),
    })
        .shardBy("userId")
        .index("by_status", ["status"])
        .index("by_expiresAt", ["expiresAt"])
        .index("by_userId_status", ["userId", "status"])
        .index("by_threadId", ["threadId"])
        .relations((r) => {
            return {
                chunks: r.many("persistentChunks", { field: "streamId" }),
            };
        }),

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
        order: v.optional(v.number()),
        organizationId: v.optional(v.string()),
        pinnedAt: v.optional(v.number()),
        projectType: v.optional(v.union(v.literal("chat"), v.literal("workflow"))),
        publicAccessToken: v.optional(v.string()),
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
        // `.global()`, not `.shardBy("userId")`: read across users — see
        // docs/plans/per-user-sharding.md.
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
        // `.global()`, not `.shardBy("userId")`: read across users — see
        // docs/plans/per-user-sharding.md.
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
        // `.global()`, not `.shardBy("userId")`: read across users — see
        // docs/plans/per-user-sharding.md.
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
        .index("key", ["key"]),

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
        .index("by_key", ["key"]),

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
        .index("by_userId", ["userId"])
        .index("by_status", ["status"]),

    session: defineTable({
        activeOrganizationId: v.optional(v.string()),
        activeTeamId: v.optional(v.string()),
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
        shardKey: v.string(),
    })
        .global()
        .index("by_shardKey", ["shardKey"])
        .index("by_lastActiveAt", ["lastActiveAt"])
        .index("by_nextDueAt", ["nextDueAt"]),

    /**
     * Lookup from a key known BEFORE the owner is to the owner's shard
     * (docs/plans/per-user-sharding.md): a public share token, a messenger
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
        childThreadId: v.optional(v.string()),
        completedAt: v.optional(v.number()),
        createdAt: v.number(),
        depth: v.number(),
        error: v.optional(v.string()),
        organizationId: v.optional(v.string()),
        // The delegating run's model, inherited when still allowed.
        parentModel: v.optional(v.string()),
        parentThreadId: v.string(),
        result: v.optional(v.string()),
        // When the result reached the parent thread. The post waits while the
        // parent is still streaming (`sub-agents/functions.ts:postRunResult`).
        resultPostedAt: v.optional(v.number()),
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
        .index("by_user_and_status", ["userId", "status"])
        .index("by_user_and_toolCallId", ["userId", "toolCallId"])
        .index("by_user_and_createdAt", ["userId", "createdAt"])
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
        lastRunThreadId: v.optional(v.string()),
        maxRepairRounds: v.number(),
        model: v.optional(v.string()),
        nextRunAt: v.optional(v.number()),
        // The creator's active organization when the task was last saved —
        // server-side, never from args. Lets a headless run resolve a skill
        // shared with that organization, after re-checking membership.
        organizationId: v.optional(v.string()),
        parentTaskId: v.optional(v.id("tasks")),
        // Denormalised `cronExpression !== undefined`, so the due scan has an equality prefix.
        recurring: v.boolean(),
        resultSummary: v.optional(v.string()),
        reviewNote: v.optional(v.string()),
        skillId: v.optional(v.id("skills")),
        status: vTaskStatus,
        successCriteria: v.optional(v.string()),
        title: v.string(),
        updatedAt: v.number(),
        userId: v.string(),
    })
        .shardBy("userId")
        .index("by_user_and_status", ["userId", "status"])
        .index("by_user_and_goal", ["userId", "goalId"])
        .index("by_recurring_and_nextRunAt", ["recurring", "nextRunAt"])
        .index("by_status_and_updatedAt", ["status", "updatedAt"]),

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
        threadId: v.id("threads"),
        userId: v.string(),
    })
        // `.global()`, not `.shardBy("userId")`: read across users — see
        // docs/plans/per-user-sharding.md.
        .global()
        .index("by_thread_and_user", ["threadId", "userId"])
        .index("by_user_and_owner", ["userId", "ownerId"])
        .relations((r) => {
            return {
                thread: r.one("threads", { field: "threadId" }),
            };
        }),

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
        // `.global()`, not `.shardBy("userId")`: read across users — see
        // docs/plans/per-user-sharding.md.
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

    threadPins: defineTable({
        createdAt: v.number(),
        messageId: v.string(),
        messageRole: v.union(v.literal("user"), v.literal("assistant")),
        note: v.optional(v.string()),
        selectedText: v.optional(v.string()),
        threadId: v.id("threads"),
        updatedAt: v.number(),
        userId: v.string(),
    })
        .shardBy("userId")
        .index("by_thread", ["threadId"])
        .index("by_user_and_thread", ["userId", "threadId"])
        .relations((r) => {
            return {
                thread: r.one("threads", { field: "threadId" }),
            };
        }),

    threadRelationships: defineTable({
        branchPoint: v.optional(v.number()),
        branchType: v.optional(v.union(v.literal("branch"), v.literal("continuation"), v.literal("comparison"), v.literal("subagent"))),
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
        // The message the user last pointed the in-thread branch switcher at.
        // Unset = the thread never branched, and reads stay on the linear fast
        // path. The displayed path descends from here by latest child.
        activeLeafMessageId: v.optional(v.string()),
        category: v.optional(v.string()),
        createdBy: v.optional(v.string()),
        customSystemPrompt: v.optional(v.string()),
        deleted: v.optional(v.boolean()),
        deletedAt: v.optional(v.number()),
        dictationLanguage: v.optional(v.string()),
        enabledFeatures: v.optional(v.array(v.string())),
        externalThreadId: v.optional(v.string()),
        // Multi-agent group chat: participants (skill ids) and who-speaks mode.
        // Written only by `chat/group/functions.ts`, which checks access.
        groupChat: v.optional(vGroupChat),
        isPublic: v.optional(v.boolean()),
        isTemporary: v.optional(v.boolean()),
        language: v.optional(v.string()),
        lastCompressionStartedAt: v.optional(v.number()),
        messengerConnectionId: v.optional(v.id("messengerConnections")),
        mode: v.optional(v.string()),
        model: v.optional(v.string()),
        multiChat: v.optional(v.boolean()),
        order: v.optional(v.number()),
        organizationId: v.optional(v.string()),
        parentThreadIds: v.optional(v.array(v.string())),
        pinnedAt: v.optional(v.number()),
        projectId: v.optional(v.id("projects")),
        publicAccessToken: v.optional(v.string()),
        reasoningEffort: v.optional(v.number()),
        source: v.optional(v.string()),
        statelessMode: v.optional(v.boolean()),
        status: v.string(),
        summary: v.optional(v.string()),
        // User-defined `threadTags` ids. NOT `tags` — that column holds
        // system-assigned source labels ("chat", "telegram", ...).
        tagIds: v.optional(v.array(v.string())),
        tags: v.optional(v.array(v.string())),
        teamId: v.optional(v.string()),
        title: v.optional(v.string()),
        updatedAt: v.optional(v.number()),
        userId: v.optional(v.string()),
    })
        .shardBy("userId")
        // The usage backfill's walk (`usage/backfill.ts`): a key no thread edit
        // moves, so a thread archived or restored mid-walk is neither skipped
        // nor seen twice.
        .index("by_userId", ["userId"])
        .index("by_user_and_status", ["userId", "status", "deleted"])
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
        .searchIndex("title", { field: "title", filterFields: ["userId"] })
        .searchIndex("summary", { field: "summary", filterFields: ["userId"] })
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
        resolvedAt: v.optional(v.number()),
        resolvedBy: v.optional(v.string()),
        status: v.union(v.literal("pending"), v.literal("approved"), v.literal("denied")),
        streamId: v.optional(v.string()),
        threadId: v.string(),
        userId: v.string(),
    })
        .shardBy("userId")
        .index("by_approvalId", ["approvalId"])
        .index("by_threadId", ["threadId"])
        .index("by_status_createdAt", ["status", "createdAt"])
        .index("by_status_resolvedAt", ["status", "resolvedAt"])
        // The home dashboard's "needs you" (`home/overview.ts`).
        .index("by_userId_status_createdAt", ["userId", "status", "createdAt"]),

    triggerExecutions: defineTable({
        completedAt: v.optional(v.number()),
        error: v.optional(v.string()),
        payload: v.optional(v.string()),
        startedAt: v.number(),
        status: v.union(v.literal("running"), v.literal("completed"), v.literal("failed")),
        threadId: v.optional(v.string()),
        triggerId: v.id("triggers"),
    }).index("by_triggerId_startedAt", ["triggerId", "startedAt"]),

    triggers: defineTable({
        createdAt: v.number(),
        cronExpression: v.optional(v.string()),
        description: v.optional(v.string()),
        enabled: v.boolean(),
        eventConnectionId: v.optional(v.string()),
        eventFilter: v.optional(v.string()),
        eventProvider: v.optional(v.string()),
        eventType: v.optional(v.string()),
        inputTemplate: v.optional(v.string()),
        lastError: v.optional(v.string()),
        lastTriggeredAt: v.optional(v.number()),
        model: v.string(),
        name: v.string(),
        nextTriggerAt: v.optional(v.number()),
        organizationId: v.optional(v.string()),
        payloadTemplate: v.optional(v.string()),
        searchMode: v.optional(v.string()),
        systemPrompt: v.optional(v.string()),
        timezone: v.optional(v.string()),
        triggerCount: v.number(),
        type: v.union(v.literal("schedule"), v.literal("webhook"), v.literal("event")),
        updatedAt: v.number(),
        userId: v.string(),
        webhookSecret: v.optional(v.string()),
    })
        .shardBy("userId")
        .index("by_userId_organizationId", ["userId", "organizationId"])
        .index("by_type_enabled", ["type", "enabled"])
        .index("by_enabled_nextTriggerAt", ["enabled", "nextTriggerAt"]),

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
    // breakdown (`usage/activity.ts`). Written by `afterRun` once per reply —
    // one `__total__` row per day plus one row per (day, skill). New data only:
    // there is no backfill from older messages.
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
        replies: v.number(),
        // `__total__`, `__assistant__`, a skill id, or `draft:<slug>`. See `usage/activity-logic.ts`.
        skillKey: v.string(),
        skillName: v.optional(v.string()),
        tokens: v.number(),
        updatedAt: v.number(),
        userId: v.string(),
    })
        .shardBy("userId")
        .index("by_user_skill_date", ["userId", "skillKey", "date"])
        .index("by_user_date", ["userId", "date"])
        // The retention sweep (`gdpr/retention.ts`), which serves a whole shard.
        .index("by_date", ["date"]),

    // The replies already in `usageDaily`, keyed by the reply's first row id:
    // what makes `recordReplyUsage` and the backfill count a reply once.
    // Pruned by `usage/backfill.ts#sweepUsageRollup` once the backfill is done.
    usageReplies: defineTable({
        recordedAt: v.number(),
        replyKey: v.string(),
        userId: v.string(),
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
        // Opt-in: speak every finished reply aloud (`features/chat/voice-mode`). Absent = off.
        autoReadReplies: v.optional(v.boolean()),
        codeFont: v.optional(v.string()),
        codeHighlightTheme: v.optional(v.string()),
        // Opt-in composer ghost-text completions (`chat/autocomplete.ts`). Absent = off.
        composerAutocompleteEnabled: v.optional(v.boolean()),
        customInstructions: v.optional(v.string()),
        // Opt-in morning summary (`notifications/daily-brief.ts`). Absent = off.
        dailyBriefEnabled: v.optional(v.boolean()),
        dictationLanguage: v.optional(v.string()),
        disableExternalLinkWarning: v.optional(v.boolean()),
        enableFollowupSuggestions: v.optional(v.boolean()),
        favoriteModels: v.optional(v.array(v.string())),
        hidePersonalInfo: v.optional(v.boolean()),
        isAdvancedUser: v.optional(v.boolean()),
        keyboardShortcuts: v.optional(v.any()),
        language: v.optional(v.string()),
        lastChatId: v.optional(v.string()),
        location: v.optional(v.string()),
        mainFont: v.optional(v.string()),
        memoryEnabled: v.optional(v.boolean()),
        mermaidTheme: v.optional(v.string()),
        nickname: v.optional(v.string()),
        onboardingCompleted: v.optional(v.boolean()),
        profession: v.optional(v.string()),
        sendBehavior: v.optional(v.string()),
        temporaryChatRetentionHours: v.optional(v.number()),
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
    })
        // `.global()`, not `.shardBy("userId")`: read across users — see
        // docs/plans/per-user-sharding.md.
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
    // `payment_sessions`, `payment_subscriptions`, `payment_usageEvents`), owned by
    // the billing module. Merged, never copied: the store reads and writes them by
    // these names, which the package may change on any upgrade.
    .extend(paymentExtension);

export default schema;
