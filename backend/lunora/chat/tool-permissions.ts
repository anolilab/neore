/**
 * Per-tool permissions: settings procedures and the tool-approval round trip.
 *
 * The resolution rules live in `lib/tool-permissions.ts`; this module stores
 * overrides, lists what can be configured, and answers a `tool-approval-request`.
 * The resumed run itself is `continueAfterToolApproval` in `chat/execute.ts`.
 *
 * Approval flow:
 * 1. `runStreamingAgent` builds tools through `buildAgentTools`; an `ask` tool
 *    carries `needsApproval: true`, so the AI SDK stops the step with a
 *    `tool-approval-request` part, which the agent persists on the assistant
 *    message. The UI renders it as `state: "approval-requested"`.
 *    Before its stream closes the run records a `toolApprovalRuns` snapshot of
 *    itself (model, search mode, research depth, exact MCP servers and tool
 *    names with their permission keys, final system prompt) per request.
 *    An `askUser` question is such a request too, but is answered through
 *    `chat/ask-user.ts` (`answerAskUser`); this procedure refuses it.
 * 2. The thread OWNER clicks Approve / Deny / Always allow / Allow for 1 hour /
 *    Allow for today → `respondToToolApproval`
 *    claims the snapshot (see `lib/tool-approval-claim.ts`), opens a NEW
 *    persistent stream on the thread (the client's streaming placeholder picks it
 *    up through `getActiveStreamForThread`) and schedules
 *    `continueAfterToolApproval`.
 * 3. That action rebuilds the run from the snapshot, lets the agent execute (or
 *    deny) the call via `approveToolCall` / `denyToolCall`, and pipes the
 *    continuation into `persistentChunks` exactly like the original run.
 */
import { MAX_LENGTH } from "../lib/validators";
import { LunoraError, v } from "lunorash/server";

import { internal } from "../_generated/internal";
import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { internalMutation, internalQuery } from "../_generated/server";
import type { AuthMutationCtx } from "../lib/crpc";
import { saveAiUserPreferences } from "../auth/lib/preference-writes";
import { isDeviceEligibleThread } from "../devices/internal";
import { getConnectorMcpServers, withMcpServerGrants } from "../connectors/lib/grant-runtime";
import { authAction, authMutation, authQuery, rateLimit } from "../lib/crpc";
import { checkRateLimit } from "../lib/rate-limiter";
import { notifyQuietly } from "../notifications/notify";
import type { MCPServerConfig } from "./lib/mcp-tools";
import { assertSafeMcpUrl, headersToRecord } from "./lib/mcp-tools";
import type { ToolPermissionGrants } from "./lib/tool-permission-grants";
import { activeGrants, grantExpiry, isGrantableKey, MAX_TOOL_GRANTS } from "./lib/tool-permission-grants";
import type { ToolApprovalDecision } from "./lib/tool-approval-claim";
import { claimToolApproval, findPendingApprovalOnLatestTurn } from "./lib/tool-approval-claim";
import { purgeExpiredToolApprovalRunsForUser } from "./lib/tool-approval-cleanup";
import { listBuiltInTools } from "./lib/tool-builder";
import type { ToolPermissionMode } from "./lib/tool-permissions";
import { defaultToolPermission, toolPermissionKey } from "./lib/tool-permissions";
import { resumeClaimedRun } from "./lib/tool-approval-resume";
import { connectorTrustId, liveTrustedServers, MAX_TRUSTED_SERVERS, mcpTrustId } from "./lib/low-risk-trust";
import { vToolRunConfig } from "./lib/tool-run-config";
import { ASK_USER_TOOL_NAME } from "./tools/ask-user-constants";
import { DEFAULT_RECENT_MESSAGES } from "../agent/shared";
import { threadSummaryTaint } from "../agent/thread-summary-taint";
import { REQUEST_SECRET_TOOL_NAME } from "./tools/request-secret-constants";

const vToolPermissionMode = v.union(v.literal("auto"), v.literal("ask"), v.literal("off"));
const vToolPermissions = v.record(v.string(), vToolPermissionMode);
/** Permission key -> epoch ms the time-boxed allow lapses. */
const vToolPermissionGrants = v.record(v.string(), v.number());

/** Keys are short identifiers, never free text; cap them so the record cannot bloat. */
const MAX_KEY_LENGTH = 256;
const MAX_OVERRIDES = 500;

/**
 * A trust entry is `mcp:` plus a JSON pair of a name and a url. `JSON.stringify` writes a control character as
 * `\u00XX`, six characters for one, so the capped name and url can grow six-fold; the fixed part is `mcp:["","]"`.
 */
export const MAX_TRUST_ENTRY_LENGTH = 11 + 6 * (MAX_LENGTH.short + MAX_LENGTH.url);
/** Preference rows one sweep looks at; a user shard holds the one row of its user. */
const PRUNE_BATCH = 50;

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export const getToolPermissionsQuery = internalQuery
    .input({ userId: v.string() })
    .output(vToolPermissions)
    .query(async ({ args: { userId }, ctx }) => {
        const prefs = await ctx.db
            .query("aiUserPreferences")
            .withIndex("by_userId", (q) => q.eq("userId", userId))
            .unique();

        return prefs?.toolPermissions ?? {};
    });

/** The user's time-boxed allows, lapsed ones included — the resolver judges them against the clock. */
export const getToolPermissionGrantsQuery = internalQuery
    .input({ userId: v.string().max(MAX_LENGTH.id) })
    .output(vToolPermissionGrants)
    .query(async ({ args: { userId }, ctx }) => {
        const prefs = await ctx.db
            .query("aiUserPreferences")
            .withIndex("by_userId", (q) => q.eq("userId", userId))
            .unique();

        return prefs?.toolPermissionGrants ?? {};
    });

type QuickCheckCtx = Pick<QueryCtx, "db">;

/**
 * The user's opt-in is on, the thread is one only they write to (`isDeviceEligibleThread`), and none of its context
 * summaries folded in untrusted content: a summary reaches the model as notes in its system prompt, so a web page or
 * tool result that scrolled out of the window still shapes the call (`agent/thread-summary-taint.ts`).
 */
const quickCheckAllowed = async (
    ctx: QuickCheckCtx,
    threadId: Id<"threads">,
    userId: string,
    call?: { permissionKey: string; trustId: string | undefined },
): Promise<boolean> => {
    const prefs = await ctx.db
        .query("aiUserPreferences")
        .withIndex("by_userId", (q) => q.eq("userId", userId))
        .unique();

    if (prefs?.autoApproveLowRisk !== true) {
        return false;
    }

    // A mode the user set for this tool themselves is theirs to answer, also when they set it while the run was going.
    if (call !== undefined && prefs.toolPermissions?.[call.permissionKey] !== undefined) {
        return false;
    }

    // Trust is the user's to take back, also while the run is going; a call that names no server is not trusted.
    if (call !== undefined && (call.trustId === undefined || !liveTrustedServers(prefs.lowRiskTrustedServers, prefs.mcpServers).includes(call.trustId))) {
        return false;
    }

    const thread = await ctx.db.get(threadId);
    const grant = await ctx.db.threadAccess.findFirst({ where: { threadId } });

    if (!isDeviceEligibleThread(thread, userId, grant !== null)) {
        return false;
    }

    // An imported conversation's rows come from an outside export file, and an agent switch hands the earlier
    // conversation over as one quoted message: no taint signal can see inside either.
    if (thread?.createdBy?.startsWith("import:") || thread?.hasHandoff === true) {
        return false;
    }

    // The agent reads only the last `DEFAULT_RECENT_MESSAGES` rows. Past that, a web or tool result can leave the
    // window while the reply that passed it on stays, and nothing in the window marks it: never judge such a thread.
    const rows = await ctx.db
        .query("messages")
        .withIndex("by_threadId_order_stepOrder", (q) => q.eq("threadId", threadId))
        .take(DEFAULT_RECENT_MESSAGES + 1);

    if (rows.length > DEFAULT_RECENT_MESSAGES) {
        return false;
    }

    // A row someone else wrote (a collaborator before the sharing ended) is text the person did not write.
    if (rows.some((row) => row.userId !== undefined && row.userId !== userId)) {
        return false;
    }

    const summaryTaint = await threadSummaryTaint(ctx, threadId);

    return summaryTaint.length === 0;
};

/**
 * Whether the quick check may judge this run's `ask` calls: the user turned it on AND the thread is one only they
 * can write to (`isDeviceEligibleThread`: not shared, public, a group chat or a messenger conversation). In anyone
 * else's thread the tool would run with the owner's servers and keys on a collaborator's turn, which only the owner
 * may approve. Read once at run start; each call re-reads it in {@link consumeLowRiskCheck}.
 */
export const getLowRiskApprovalContext = internalQuery
    .input({
        permissionKey: v.optional(v.string().max(MAX_KEY_LENGTH)),
        threadId: v.id("threads"),
        // Which trusted server the call belongs to (`low-risk-trust.ts`); required with a `permissionKey`, or the call is refused.
        trustId: v.optional(v.string().max(MAX_TRUST_ENTRY_LENGTH)),
        userId: v.string(),
    })
    .output(v.boolean())
    .query(
        async ({ args: { permissionKey, threadId, trustId, userId }, ctx }) =>
            await quickCheckAllowed(ctx, threadId, userId, permissionKey === undefined ? undefined : { permissionKey, trustId }),
    );

/** The servers the user trusts to have their tools put to the quick check, as the run builds its tools. */
export const getLowRiskTrustedServers = internalQuery
    .input({ userId: v.string() })
    .output(v.array(v.string()))
    .query(async ({ args: { userId }, ctx }) => {
        const prefs = await ctx.db
            .query("aiUserPreferences")
            .withIndex("by_userId", (q) => q.eq("userId", userId))
            .unique();

        return liveTrustedServers(prefs?.lowRiskTrustedServers, prefs?.mcpServers);
    });

/**
 * Spends one unit of the user's quick-check budget for ONE call, after re-reading the setting and the thread's
 * sharing in the same write — so switching the setting off, or sharing the thread, takes effect on the next call of a
 * run already under way. `false` (nothing spent) when either no longer holds, or the budget is spent.
 */
export const consumeLowRiskCheck = internalMutation
    .input({ threadId: v.id("threads"), userId: v.string() })
    .output(v.boolean())
    .mutation(async ({ args: { threadId, userId }, ctx }) => {
        if (!(await quickCheckAllowed(ctx, threadId, userId))) {
            return false;
        }

        const budget = await checkRateLimit(ctx, "chat/toolAutoApprove", { count: 1, key: userId });

        return budget.ok;
    });

/**
 * Built-in tools plus the caller's stored overrides. MCP tools need a live
 * connection to enumerate, so they come from {@link listMcpToolPermissions}.
 */
export const getToolPermissionSettings = authQuery
    .input({})
    .output(
        v.object({
            // The opt-in quick check for low-risk calls (`chat/lib/low-risk-approval.ts`). Off unless the user turned it on.
            autoApproveLowRisk: v.boolean(),
            builtIn: v.array(
                v.object({
                    available: v.boolean(),
                    category: v.string(),
                    defaultMode: vToolPermissionMode,
                    key: v.string(),
                    name: v.string(),
                }),
            ),
            // Time-boxed allows still in force. A live query does not re-run when one lapses, so the page also hides by `expiresAt`.
            grants: vToolPermissionGrants,
            // Servers trusted for the quick check, as `low-risk-trust.ts` names them.
            lowRiskTrustedServers: v.array(v.string()),
            overrides: vToolPermissions,
        }),
    )
    .query(async ({ ctx }) => {
        const prefs = await ctx.db
            .query("aiUserPreferences")
            .withIndex("by_userId", (q) => q.eq("userId", ctx.user.userId))
            .unique();

        return {
            autoApproveLowRisk: prefs?.autoApproveLowRisk === true,
            builtIn: listBuiltInTools().map(({ available, category, name }) => {
                return { available, category, defaultMode: defaultToolPermission("builtin", undefined, name), key: toolPermissionKey("builtin", name), name };
            }),
            grants: activeGrants(prefs?.toolPermissionGrants, Date.now()),
            lowRiskTrustedServers: liveTrustedServers(prefs?.lowRiskTrustedServers, prefs?.mcpServers),
            overrides: prefs?.toolPermissions ?? {},
        };
    });

/**
 * Connects to each enabled MCP server, lists its tools with their annotations,
 * and reports each tool's permission key and default mode.
 */
export const listMcpToolPermissions = authAction
    .use(rateLimit("mcp/proxy"))
    .input({})
    .output(
        v.object({
            servers: v.array(
                v.object({
                    error: v.union(v.string(), v.null()),
                    name: v.string(),
                    tools: v.array(
                        v.object({
                            defaultMode: vToolPermissionMode,
                            description: v.optional(v.string()),
                            destructive: v.boolean(),
                            key: v.string(),
                            name: v.string(),
                            readOnly: v.boolean(),
                        }),
                    ),
                }),
            ),
        }),
    )
    .action(async ({ ctx }) => {
        const allServers = (await ctx.runQuery(internal.auth.functions.getMCPServersQuery, { userId: ctx.user.userId })) as MCPServerConfig[];
        // Connected connectors are MCP servers too, keyed `connector:<slug>:<tool>`.
        const connectorServers = await getConnectorMcpServers(ctx, ctx.user.userId).catch((): MCPServerConfig[] => []);
        const signedIn = await withMcpServerGrants(ctx, ctx.user.userId, allServers).catch(() => allServers);
        const servers = [...signedIn.filter((s) => s.enabled), ...connectorServers];

        if (servers.length === 0) {
            return { servers: [] };
        }

        const { createMCPClient } = await import("@ai-sdk/mcp");

        const results = await Promise.allSettled(
            servers.map(async (config) => {
                assertSafeMcpUrl(config.url);

                const headers = headersToRecord(config.headers);
                const client = await createMCPClient({
                    transport: { type: config.protocol, url: config.url, ...(headers && { headers }) },
                });

                try {
                    const { tools } = await client.listTools();

                    return tools.map((t) => {
                        const annotations = t.annotations ?? undefined;

                        return {
                            defaultMode: defaultToolPermission(config.connectorSlug ? "connector" : "mcp", annotations),
                            ...(t.description && { description: t.description.slice(0, 500) }),
                            destructive: annotations?.destructiveHint === true,
                            key: config.connectorSlug
                                ? toolPermissionKey("connector", t.name, config.connectorSlug)
                                : toolPermissionKey("mcp", t.name, config.name),
                            name: t.name,
                            readOnly: annotations?.readOnlyHint === true,
                        };
                    });
                } finally {
                    await client.close().catch(() => {});
                }
            }),
        );

        ctx.log.event("chat.list_mcp_tool_permissions", {
            failed: results.filter((result) => result.status === "rejected").length,
            servers: servers.length,
        });

        return {
            servers: results.map((result, index) => {
                const { name } = servers[index] as MCPServerConfig;

                return result.status === "fulfilled"
                    ? { error: null, name, tools: result.value }
                    : { error: String(result.reason?.message ?? result.reason), name, tools: [] };
            }),
        };
    });

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

type PreferenceCtx = Pick<AuthMutationCtx, "db" | "now" | "user">;

/** Patches ONE key, so concurrent writes to different tools do not clobber each other. */
const writeToolPermission = async (ctx: PreferenceCtx, key: string, mode: ToolPermissionMode | null): Promise<void> => {
    const { userId } = ctx.user;
    const prefs = await ctx.db
        .query("aiUserPreferences")
        .withIndex("by_userId", (q) => q.eq("userId", userId))
        .unique();

    const next: Record<string, ToolPermissionMode> = { ...prefs?.toolPermissions };

    if (mode === null) {
        delete next[key];
    } else {
        next[key] = mode;
    }

    if (Object.keys(next).length > MAX_OVERRIDES) {
        throw new LunoraError("BAD_REQUEST", "Too many tool permission overrides");
    }

    await saveAiUserPreferences(ctx.db, prefs, userId, { toolPermissions: next });
};

/** Set (or, with `mode: null`, reset to default) one tool's permission. */
export const setToolPermission = authMutation
    .use(rateLimit("chat/update"))
    .input({
        key: v.string().check((value) => value.length > 0 && value.length <= MAX_KEY_LENGTH, { message: "Invalid tool key" }),
        mode: v.union(vToolPermissionMode, v.null()),
    })
    .output(v.null())
    .mutation(async ({ args: { key, mode }, ctx }) => {
        await writeToolPermission(ctx, key, mode);
        // An explicit choice replaces a time-boxed allow: picking "Ask" must ask, not wait out the allow.
        await writeToolGrant(ctx, key, null);

        ctx.log.event("chat.set_tool_permission", { cleared: mode === null });

        return null;
    });

/** Turn the opt-in quick check for low-risk `ask` calls on or off. Off is the default. */
export const setAutoApproveLowRisk = authMutation
    .use(rateLimit("chat/update"))
    .input({ enabled: v.boolean() })
    .output(v.null())
    .mutation(async ({ args: { enabled }, ctx }) => {
        const prefs = await ctx.db
            .query("aiUserPreferences")
            .withIndex("by_userId", (q) => q.eq("userId", ctx.user.userId))
            .unique();

        await saveAiUserPreferences(ctx.db, prefs, ctx.user.userId, { autoApproveLowRisk: enabled });

        ctx.log.event("chat.set_auto_approve_low_risk", { enabled });

        return null;
    });

const vTrustedServer = v.union(
    v.object({ kind: v.literal("mcp"), name: v.string().max(MAX_LENGTH.short), url: v.string().max(MAX_LENGTH.url) }),
    v.object({ kind: v.literal("connector"), slug: v.string().max(MAX_LENGTH.short) }),
);

/**
 * Trust (or stop trusting) ONE server for the quick check. The entry is built here from the server's identity, so a
 * client cannot write anything else into the list, and only a server the user has saved can be added.
 */
export const setLowRiskTrustedServer = authMutation
    .use(rateLimit("chat/update"))
    .input({ server: vTrustedServer, trusted: v.boolean() })
    .output(v.null())
    .mutation(async ({ args: { server, trusted }, ctx }) => {
        const prefs = await ctx.db
            .query("aiUserPreferences")
            .withIndex("by_userId", (q) => q.eq("userId", ctx.user.userId))
            .unique();

        if (trusted && server.kind === "mcp" && !prefs?.mcpServers?.some((saved) => saved.name === server.name && saved.url === server.url)) {
            throw new LunoraError("BAD_REQUEST", "Unknown MCP server");
        }

        const id = server.kind === "mcp" ? mcpTrustId(server.name, server.url) : connectorTrustId(server.slug);
        const next = liveTrustedServers(prefs?.lowRiskTrustedServers, prefs?.mcpServers).filter((entry) => entry !== id);

        if (trusted) {
            next.push(id);
        }

        if (next.length > MAX_TRUSTED_SERVERS) {
            throw new LunoraError("BAD_REQUEST", "Too many trusted servers");
        }

        await saveAiUserPreferences(ctx.db, prefs, ctx.user.userId, { lowRiskTrustedServers: next });

        ctx.log.event("chat.set_low_risk_trusted_server", { kind: server.kind, trusted });

        return null;
    });

/** Records (or, with `expiresAt: null`, drops) ONE time-boxed allow, pruning lapsed ones in the same write. */
const writeToolGrant = async (ctx: PreferenceCtx, key: string, expiresAt: number | null): Promise<void> => {
    const { userId } = ctx.user;
    const prefs = await ctx.db
        .query("aiUserPreferences")
        .withIndex("by_userId", (q) => q.eq("userId", userId))
        .unique();

    const next: ToolPermissionGrants = activeGrants(prefs?.toolPermissionGrants, ctx.now);

    if (expiresAt === null) {
        delete next[key];
    } else {
        next[key] = expiresAt;
    }

    // At the cap the allow that ends soonest makes room, so the approval the user just gave never fails on it.
    const byExpiry = Object.entries(next)
        .filter(([grantKey]) => grantKey !== key)
        .toSorted(([, left], [, right]) => left - right);

    while (Object.keys(next).length > MAX_TOOL_GRANTS && byExpiry.length > 0) {
        const [soonest] = byExpiry.shift()!;

        delete next[soonest];
    }

    await saveAiUserPreferences(ctx.db, prefs, userId, { toolPermissionGrants: next });
};

/** End a time-boxed allow early: the tool asks again from the next message (a run already going keeps the allow it started with). */
export const revokeToolPermissionGrant = authMutation
    .use(rateLimit("chat/update"))
    .input({
        key: v.string().check((value) => value.length > 0 && value.length <= MAX_KEY_LENGTH, { message: "Invalid tool key" }),
    })
    .output(v.null())
    .mutation(async ({ args: { key }, ctx }) => {
        await writeToolGrant(ctx, key, null);

        ctx.log.event("chat.revoke_tool_permission_grant", {});

        return null;
    });

/**
 * Housekeeping sweep (`shardSweeps()`): drops lapsed time-boxed allows from the
 * rows on this shard. A lapsed one is already ignored, so this only keeps the
 * record small.
 */
export const pruneExpiredToolPermissionGrants = internalMutation
    .input({})
    .output(v.null())
    .mutation(async ({ ctx }) => {
        const rows = await ctx.db.query("aiUserPreferences").take(PRUNE_BATCH);

        for (const row of rows) {
            const grants = row.toolPermissionGrants;

            if (grants && Object.values(grants).some((expiresAt) => expiresAt <= ctx.now)) {
                await saveAiUserPreferences(ctx.db, row, row.userId, { toolPermissionGrants: activeGrants(grants, ctx.now) });
            }
        }

        return null;
    });

/**
 * Snapshot a run that paused on approval requests, one row per request. Written
 * by the run itself (and by a continuation that pauses again, inheriting the
 * same snapshot) before its stream closes.
 */
export const recordPendingToolApprovals = internalMutation
    .input({
        approvalIds: v.array(v.string()),
        // The subset of `approvalIds` that are `askUser` questions rather than
        // tool calls — they notify as "a question is waiting", not "approve".
        askUserApprovalIds: v.optional(v.array(v.string())),
        config: vToolRunConfig,
        // The subset that are `requestSecret` cards: answered with a value, not approved, so they notify as their own thing.
        secretApprovalIds: v.optional(v.array(v.string().max(MAX_LENGTH.id))),
        threadId: v.string(),
        userId: v.string(),
    })
    .output(v.null())
    .mutation(async ({ args: { approvalIds, askUserApprovalIds, config, secretApprovalIds, threadId, userId }, ctx }) => {
        const createdAt = ctx.now;
        const thread = await ctx.db.get(threadId as Id<"threads">);
        // The row belongs to the thread OWNER, whoever's turn paused: only the
        // owner can answer (`claimToolApproval` requires `run.userId` to be the
        // owner), and their home's "Needs you" lists rows by `userId`. Stored
        // under a collaborator's id, it was on neither dashboard and could not
        // be answered at all.
        const ownerId = thread?.userId ?? userId;

        await purgeExpiredToolApprovalRunsForUser(ctx, ownerId, createdAt);

        const uniqueIds = new Set(approvalIds);

        for (const approvalId of uniqueIds) {
            await ctx.db.insert("toolApprovalRuns", { approvalId, config, createdAt, status: "pending", threadId, userId: ownerId });
        }

        // One notification per pause, to the thread OWNER — only they can answer
        // (`respondToToolApproval`). A secret request and a question take precedence over approvals: they are
        // answered with something, and nothing offers to "approve" them.
        const askUserIds = new Set(askUserApprovalIds);
        const secretIds = new Set(secretApprovalIds);
        const [first] = uniqueIds;
        const secret = [...uniqueIds].find((id) => secretIds.has(id));
        const question = [...uniqueIds].find((id) => askUserIds.has(id));

        if (first !== undefined) {
            let type: "ask_user" | "secret_request" | "tool_approval" = "tool_approval";

            if (secret !== undefined) {
                type = "secret_request";
            } else if (question !== undefined) {
                type = "ask_user";
            }

            const key = secret ?? question ?? first;

            await notifyQuietly(ctx, {
                dedupeKey: `${type}:${key}`,
                link: `/chat/${threadId}`,
                title: thread?.title ?? "Chat",
                type,
                userId: ownerId,
            });
        }

        return null;
    });

/**
 * What an answer leaves behind for next time: `always` stores `auto` for the tool, `hour` / `today` a time-boxed
 * allow. `key` is the permission key recorded when the tool was built; a snapshot without one approves a plain or
 * "always" answer once and stores nothing rather than guessing, and refuses `hour` / `today`, which it could not keep.
 */
export const recordApprovalPreference = async (ctx: PreferenceCtx, decision: ToolApprovalDecision, key: string | undefined): Promise<void> => {
    if (!key) {
        // Approving once and storing nothing would leave the user believing the tool is allowed for the period.
        // The throw rolls the claim back.
        if (decision === "hour" || decision === "today") {
            throw new LunoraError("BAD_REQUEST", "This call can only be approved once");
        }

        return;
    }

    if (decision === "always") {
        await writeToolPermission(ctx, key, "auto");
        await writeToolGrant(ctx, key, null);
    } else if (decision === "hour" || decision === "today") {
        // A device call is approved again on the device, with taint only known there, so no allow covers it here.
        // The throw rolls the claim back.
        if (!isGrantableKey(key)) {
            throw new LunoraError("BAD_REQUEST", "This tool cannot be allowed for a period");
        }

        const settings = await ctx.db
            .query("userSettings")
            .withIndex("by_userId", (q) => q.eq("userId", ctx.user.userId))
            .unique();

        await writeToolGrant(ctx, key, grantExpiry(decision, ctx.now, settings?.timezone));
    }
};

/**
 * Answer a pending tool-approval request and resume the agent run.
 *
 * - Caller must OWN the thread: the tool runs with the owner's MCP servers and
 *   keys, so a collaborator (even with `write`) cannot trigger it.
 * - `approvalId` must have a snapshot row (else: fail closed) AND be an
 *   unanswered request on the thread's latest assistant turn.
 * - Idempotent: the row's `pending -> approved|denied` transition happens once;
 *   a repeat call returns the first call's stream instead of starting another.
 *
 * What executes is the tool call stored under `approvalId`, never anything the
 * client names.
 */
export const respondToToolApproval = authMutation
    .use(rateLimit("chat/stream"))
    .input({
        approvalId: v.string().check((value) => value.length > 0 && value.length <= 256, { message: "Invalid approval id" }),
        decision: v.union(v.literal("approve"), v.literal("deny"), v.literal("always"), v.literal("hour"), v.literal("today")),
        threadId: v.id("threads"),
        unlockProof: v.optional(v.string().max(MAX_LENGTH.short)),
    })
    .output(v.object({ alreadyResolved: v.boolean(), streamId: v.union(v.string(), v.null()) }))
    .mutation(async ({ args: { approvalId, decision, threadId, unlockProof }, ctx }) => {
        const claim = await claimToolApproval(ctx, { approvalId, callerId: ctx.user.userId, decision, threadId, unlockProof });

        if (claim.kind === "already-resolved") {
            return { alreadyResolved: true, streamId: claim.streamId };
        }

        const { config, ownerId, runId, toolName } = claim;

        // A question is answered with text, not a decision (`chat/ask-user.ts`);
        // approving it here would resume the run with no answer. The throw rolls
        // the claim back.
        if (toolName === ASK_USER_TOOL_NAME) {
            throw new LunoraError("BAD_REQUEST", "Answer this question instead of approving it");
        }

        // Likewise a secret request is answered with the value (`chat/request-secret.ts`), or declined there.
        if (toolName === REQUEST_SECRET_TOOL_NAME) {
            throw new LunoraError("BAD_REQUEST", "Answer this secret request instead of approving it");
        }

        // The key recorded when the tool was built. A snapshot without one
        // approves this call and writes no preference, rather than guessing.
        const key = toolName ? config.toolPermissionKeys?.[toolName] : undefined;

        await recordApprovalPreference(ctx, decision, key);

        const streamId = await resumeClaimedRun(ctx, { approvalId, approved: decision !== "deny", config, ownerId, runId, threadId });

        ctx.log.event("chat.respond_to_tool_approval", { alreadyResolved: false, decision });

        return { alreadyResolved: false, streamId };
    });

/**
 * The continuation's own staleness check: is `approvalId` still the open request
 * on the latest turn of the caller's thread, and which tool does it name?
 */
export const getPendingToolApproval = internalQuery
    .input({ approvalId: v.string(), threadId: v.string(), userId: v.string() })
    .output(v.union(v.object({ toolName: v.union(v.string(), v.null()) }), v.null()))
    .query(async ({ args: { approvalId, threadId, userId }, ctx }) => {
        const thread = await ctx.db.get(threadId as Id<"threads">);

        if (!thread || thread.deleted || thread.userId !== userId) {
            return null;
        }

        return (await findPendingApprovalOnLatestTurn(ctx, thread._id, approvalId)) ?? null;
    });
