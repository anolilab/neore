/**
 * The home dashboard (`/dashboard`) in one query: what needs the user (tool
 * approvals and askUser questions — both are pending `toolApprovalRuns` — and
 * tasks awaiting review), what is running (tasks, coding agents, sub-agents),
 * their latest threads and unread notifications.
 *
 * ONE query so the page costs one live subscription, and every read is bounded
 * and indexed: this runs again whenever a write touches any range it read. The
 * Daily Brief reads the same snapshot (`notifications/daily-brief.ts`).
 */
import type { Infer } from "lunorash/server";
import { v } from "lunorash/server";

import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { repoLabel } from "../coding-agents/repo-label";
import { vCodingAgentId } from "../coding-agents/validators";
import { authQuery } from "../lib/crpc";
import { loadUnread, toNotificationView, UNREAD_COUNT_CAP } from "../notifications/functions";
import { vNotificationView } from "../notifications/validators";

/** Rows per section. The page shows fewer; the rest is one click away. */
export const HOME_SECTION_LIMIT = 10;
const RECENT_THREADS = 6;
/** Thread rows read to find {@link RECENT_THREADS} live ones (temporary ones are skipped). */
const THREAD_SCAN = 20;
/** Unread notifications shown on the page. */
const HOME_NOTIFICATIONS = 5;

const TITLE_MAX = 160;

const clip = (text: string): string => (text.length > TITLE_MAX ? `${text.slice(0, TITLE_MAX - 1)}…` : text);

export const vHomeOverview = v.object({
    approvals: v.array(v.object({ approvalId: v.string(), createdAt: v.number(), threadId: v.string(), threadTitle: v.optional(v.string()) })),
    codingAgents: v.array(
        v.object({
            _id: v.string(),
            agent: vCodingAgentId,
            createdAt: v.number(),
            prompt: v.string(),
            repo: v.string(),
            status: v.union(v.literal("queued"), v.literal("running")),
            threadId: v.optional(v.string()),
        }),
    ),
    dailyBriefEnabled: v.boolean(),
    notifications: v.array(vNotificationView),
    recentThreads: v.array(v.object({ _id: v.string(), title: v.optional(v.string()), updatedAt: v.number() })),
    reviews: v.array(v.object({ _id: v.string(), title: v.string(), updatedAt: v.number() })),
    runningTasks: v.array(v.object({ _id: v.string(), status: v.union(v.literal("queued"), v.literal("running")), title: v.string(), updatedAt: v.number() })),
    subAgents: v.array(
        v.object({
            _id: v.string(),
            createdAt: v.number(),
            parentThreadId: v.string(),
            status: v.union(v.literal("queued"), v.literal("running")),
            task: v.string(),
        }),
    ),
    unreadCount: v.number(),
});

export type HomeOverview = Infer<typeof vHomeOverview>;

/**
 * Pending approvals past `PENDING_APPROVAL_TTL_MS` are not filtered here — a
 * query must not read the clock (it re-runs on every relevant write). They are
 * purged on the next pause in that shard, and answering one fails closed.
 */
export const loadHomeOverview = async (ctx: Pick<QueryCtx, "db">, userId: string): Promise<HomeOverview> => {
    const [approvalRows, reviewRows, taskRows, agentRows, subAgentRows, threadRows, unread, settings] = await Promise.all([
        ctx.db.toolApprovalRuns.findMany({
            limit: HOME_SECTION_LIMIT,
            orderBy: [{ createdAt: "desc" }],
            where: { status: "pending", userId },
        }),
        ctx.db.tasks.findMany({ limit: HOME_SECTION_LIMIT, orderBy: [{ updatedAt: "desc" }], where: { status: "needs_review", userId } }),
        ctx.db.tasks.findMany({ limit: HOME_SECTION_LIMIT, orderBy: [{ updatedAt: "desc" }], where: { status: { in: ["running", "queued"] }, userId } }),
        ctx.db.codingAgentRuns.findMany({
            limit: HOME_SECTION_LIMIT,
            orderBy: [{ createdAt: "desc" }],
            where: { status: { in: ["running", "queued"] }, userId },
        }),
        ctx.db.subAgentRuns.findMany({ limit: HOME_SECTION_LIMIT, orderBy: [{ createdAt: "desc" }], where: { status: { in: ["running", "queued"] }, userId } }),
        // Most recently touched first (`by_user_and_updatedAt`), soft-deleted
        // rows excluded in SQL. Temporary threads are skipped below.
        ctx.db.threads.findMany({
            limit: THREAD_SCAN,
            orderBy: [{ updatedAt: "desc" }, { _creationTime: "desc" }],
            where: { OR: [{ deleted: { isNull: true } }, { deleted: false }], userId },
        }),
        loadUnread(ctx, userId, UNREAD_COUNT_CAP),
        ctx.db.userSettings.findFirst({ where: { userId } }),
    ]);

    // One approval per thread is enough to send the user there.
    const approvalsByThread = new Map<string, (typeof approvalRows.page)[number]>();

    for (const row of approvalRows.page) {
        if (!approvalsByThread.has(row.threadId)) {
            approvalsByThread.set(row.threadId, row);
        }
    }

    const approvalThreads = await Promise.all([...approvalsByThread.keys()].map(async (threadId) => await ctx.db.get(threadId as Id<"threads">)));
    const threadTitle = new Map(approvalThreads.flatMap((thread) => (thread?.title ? [[thread._id as string, thread.title] as const] : [])));

    return {
        approvals: [...approvalsByThread.values()].map((row) => {
            const title = threadTitle.get(row.threadId);

            return { approvalId: row.approvalId, createdAt: row.createdAt, threadId: row.threadId, ...(title && { threadTitle: clip(title) }) };
        }),
        codingAgents: agentRows.page.map((run) => {
            return {
                _id: run._id as string,
                agent: run.agent,
                createdAt: run.createdAt,
                prompt: clip(run.prompt),
                repo: repoLabel(run.repoUrl),
                status: run.status as "queued" | "running",
                ...(run.threadId && { threadId: run.threadId }),
            };
        }),
        dailyBriefEnabled: settings?.dailyBriefEnabled === true,
        notifications: unread.slice(0, HOME_NOTIFICATIONS).map((row) => toNotificationView(row)),
        recentThreads: threadRows.page
            .filter((thread) => thread.deleted !== true && thread.isTemporary !== true)
            .slice(0, RECENT_THREADS)
            .map((thread) => {
                return {
                    _id: thread._id as string,
                    updatedAt: thread.updatedAt ?? thread._creationTime,
                    ...(thread.title && { title: clip(thread.title) }),
                };
            }),
        reviews: reviewRows.page.map((task) => {
            return { _id: task._id as string, title: clip(task.title), updatedAt: task.updatedAt };
        }),
        runningTasks: taskRows.page.map((task) => {
            return { _id: task._id as string, status: task.status as "queued" | "running", title: clip(task.title), updatedAt: task.updatedAt };
        }),
        subAgents: subAgentRows.page.map((run) => {
            return {
                _id: run._id as string,
                createdAt: run.createdAt,
                parentThreadId: run.parentThreadId,
                status: run.status as "queued" | "running",
                task: clip(run.task),
            };
        }),
        unreadCount: unread.length,
    };
};

export const getHomeOverview = authQuery
    .input({})
    .output(vHomeOverview)
    .query(async ({ ctx }) => await loadHomeOverview(ctx, ctx.user.userId));
