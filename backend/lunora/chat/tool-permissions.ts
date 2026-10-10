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
 * 2. The thread OWNER clicks Approve / Deny / Always allow → `respondToToolApproval`
 *    claims the snapshot (see `lib/tool-approval-claim.ts`), opens a NEW
 *    persistent stream on the thread (the client's streaming placeholder picks it
 *    up through `getActiveStreamForThread`) and schedules
 *    `continueAfterToolApproval`.
 * 3. That action rebuilds the run from the snapshot, lets the agent execute (or
 *    deny) the call via `approveToolCall` / `denyToolCall`, and pipes the
 *    continuation into `persistentChunks` exactly like the original run.
 */
import { LunoraError, v } from "lunorash/server";

import { internal } from "../_generated/internal";
import type { Id } from "../_generated/dataModel";
import { internalMutation, internalQuery } from "../_generated/server";
import type { AuthMutationCtx } from "../lib/crpc";
import { saveAiUserPreferences } from "../auth/lib/preference-writes";
import { getConnectorMcpServers, withMcpServerGrants } from "../connectors/lib/grant-runtime";
import { authAction, authMutation, authQuery, rateLimit } from "../lib/crpc";
import { notifyQuietly } from "../notifications/notify";
import type { MCPServerConfig } from "./lib/mcp-tools";
import { assertSafeMcpUrl, headersToRecord } from "./lib/mcp-tools";
import { claimToolApproval, findPendingApprovalOnLatestTurn } from "./lib/tool-approval-claim";
import { purgeExpiredToolApprovalRunsForUser } from "./lib/tool-approval-cleanup";
import { listBuiltInTools } from "./lib/tool-builder";
import type { ToolPermissionMode } from "./lib/tool-permissions";
import { defaultToolPermission, toolPermissionKey } from "./lib/tool-permissions";
import { resumeClaimedRun } from "./lib/tool-approval-resume";
import { vToolRunConfig } from "./lib/tool-run-config";
import { ASK_USER_TOOL_NAME } from "./tools/ask-user-constants";

const vToolPermissionMode = v.union(v.literal("auto"), v.literal("ask"), v.literal("off"));
const vToolPermissions = v.record(v.string(), vToolPermissionMode);

/** Keys are short identifiers, never free text; cap them so the record cannot bloat. */
const MAX_KEY_LENGTH = 256;
const MAX_OVERRIDES = 500;

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

/**
 * Built-in tools plus the caller's stored overrides. MCP tools need a live
 * connection to enumerate, so they come from {@link listMcpToolPermissions}.
 */
export const getToolPermissionSettings = authQuery
    .input({})
    .output(
        v.object({
            builtIn: v.array(
                v.object({
                    available: v.boolean(),
                    category: v.string(),
                    defaultMode: vToolPermissionMode,
                    key: v.string(),
                    name: v.string(),
                }),
            ),
            overrides: vToolPermissions,
        }),
    )
    .query(async ({ ctx }) => {
        const prefs = await ctx.db
            .query("aiUserPreferences")
            .withIndex("by_userId", (q) => q.eq("userId", ctx.user.userId))
            .unique();

        return {
            builtIn: listBuiltInTools().map(({ available, category, name }) => {
                return { available, category, defaultMode: defaultToolPermission("builtin", undefined, name), key: toolPermissionKey("builtin", name), name };
            }),
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

/** Patches ONE key, so concurrent writes to different tools do not clobber each other. */
const writeToolPermission = async (ctx: AuthMutationCtx, key: string, mode: ToolPermissionMode | null): Promise<void> => {
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

        ctx.log.event("chat.set_tool_permission", { cleared: mode === null });

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
        threadId: v.string(),
        userId: v.string(),
    })
    .output(v.null())
    .mutation(async ({ args: { approvalIds, askUserApprovalIds, config, threadId, userId }, ctx }) => {
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
        // (`respondToToolApproval`). A question takes precedence over approvals.
        const askUserIds = new Set(askUserApprovalIds);
        const [first] = uniqueIds;
        const question = [...uniqueIds].find((id) => askUserIds.has(id));

        if (first !== undefined) {
            const key = question ?? first;

            await notifyQuietly(ctx, {
                dedupeKey: `${question === undefined ? "tool_approval" : "ask_user"}:${key}`,
                link: `/chat/${threadId}`,
                title: thread?.title ?? "Chat",
                type: question === undefined ? "tool_approval" : "ask_user",
                userId: ownerId,
            });
        }

        return null;
    });

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
        decision: v.union(v.literal("approve"), v.literal("deny"), v.literal("always")),
        threadId: v.id("threads"),
    })
    .output(v.object({ alreadyResolved: v.boolean(), streamId: v.union(v.string(), v.null()) }))
    .mutation(async ({ args: { approvalId, decision, threadId }, ctx }) => {
        const claim = await claimToolApproval(ctx, { approvalId, callerId: ctx.user.userId, decision, threadId });

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

        // The key recorded when the tool was built. A snapshot without one
        // approves this call and writes no preference, rather than guessing.
        const key = toolName ? config.toolPermissionKeys?.[toolName] : undefined;

        if (decision === "always" && key) {
            await writeToolPermission(ctx, key, "auto");
        }

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
