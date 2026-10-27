/**
 * The read behind a quiet routine's decision (`quiet.ts`).
 *
 * Not `loadDailyBriefInputs`: that one drops every timestamp, and a quiet
 * routine must tell an open request from last week from a new one. It reads the
 * same sources (`loadHomeOverview` and the user's notifications), except for
 * chats: `loadHomeOverview` keeps only the six most recently updated, so a
 * handful of routine runs updating threads after a user's chat would push that
 * chat out of view. Chats are read here by their own windowed query instead.
 * Tasks are too: a task that finished leaves the overview's review and running
 * sections, so the overview alone cannot tell that it finished inside the window.
 */
import { v } from "lunorash/server";

import type { QueryCtx } from "../_generated/server";
import { internalQuery } from "../_generated/server";
import { loadHomeOverview } from "../home/overview";
import type { QuietSnapshot } from "./quiet";
import { QUIET_IGNORED_EVENT_TYPES, TRIGGER_THREAD_TAG } from "./quiet";
import { MAX_LENGTH } from "../lib/validators";

/** Notifications read, as the brief reads them. */
const QUIET_EVENTS_READ = 50;

/** Chats read: the decision needs one, and the rest only fill the brief's list of titles. */
const QUIET_THREADS_READ = 20;

/** Tasks read: the decision needs one. */
const QUIET_TASKS_READ = 20;

/** The `type` of the event a task updated inside the window becomes. */
const TASK_EVENT_TYPE = "task";

/** A column an old row may leave unset, or set to false. */
const notSet = (field: "deleted" | "isTemporary") => {
    return { OR: [{ [field]: { isNull: true } }, { [field]: false }] };
};

/**
 * The titled run threads of a routine in which the user saved a reply after `since`, newest first. One bounded read:
 * `threads.lastUserMessageAt` is stamped by the message write for a user message past the thread's first, so the
 * routine's own prompt and answers never set it.
 */
const repliedRunThreads = async (ctx: QueryCtx, userId: string, since: number): Promise<{ title: string; updatedAt: number }[]> => {
    const result = await ctx.db.threads.findMany({
        limit: QUIET_THREADS_READ,
        orderBy: [{ lastUserMessageAt: "desc" }, { _creationTime: "desc" }],
        where: {
            AND: [notSet("deleted"), notSet("isTemporary"), { tags: { contains: JSON.stringify(TRIGGER_THREAD_TAG) } }, { lastUserMessageAt: { gt: since } }],
            lockedAt: { isNull: true },
            title: { isNull: false, ne: "" },
            userId,
        },
    });

    return result.page.flatMap((thread) =>
        thread.title && thread.lastUserMessageAt !== undefined ? [{ title: thread.title, updatedAt: thread.lastUserMessageAt }] : [],
    );
};

const vItem = v.object({ at: v.number(), kind: v.string(), title: v.string() });

export const loadQuietSnapshot = internalQuery
    .input({ since: v.number(), userId: v.string().max(MAX_LENGTH.id) })
    .output(
        v.object({
            events: v.array(v.object({ createdAt: v.number(), type: v.string() })),
            needsYou: v.array(vItem),
            running: v.array(vItem),
            threads: v.array(v.object({ title: v.optional(v.string()), updatedAt: v.number() })),
        }),
    )
    .query(async ({ args: { since, userId }, ctx }): Promise<QuietSnapshot> => {
        const [overview, recent, chats, repliedThreads, tasks] = await Promise.all([
            loadHomeOverview(ctx, userId),
            // The ignored types are left out of the read itself, so a busy routine's notifications cannot fill the limit and hide a real one.
            ctx.db.notifications.findMany({
                limit: QUIET_EVENTS_READ,
                orderBy: [{ createdAt: "desc" }],
                where: {
                    AND: QUIET_IGNORED_EVENT_TYPES.map((type) => {
                        return { type: { ne: type } };
                    }),
                    createdAt: { gt: since },
                    userId,
                },
            }),
            // Every exclusion is in the query, so routine and temporary threads cannot use up the limit and hide a chat.
            // A routine's run thread is told by its tag (`tags` is a JSON array, so the quoted label matches whole entries).
            // A locked or untitled chat never counts (an empty title counts as untitled, and is left out in the query so untitled threads cannot fill the limit).
            // A row with no `updatedAt` is dated by its creation, as the home view does.
            ctx.db.threads.findMany({
                limit: QUIET_THREADS_READ,
                orderBy: [{ updatedAt: "desc" }, { _creationTime: "desc" }],
                where: {
                    AND: [
                        notSet("deleted"),
                        notSet("isTemporary"),
                        { OR: [{ tags: { isNull: true } }, { NOT: { tags: { contains: JSON.stringify(TRIGGER_THREAD_TAG) } } }] },
                        { OR: [{ updatedAt: { gt: since } }, { AND: [{ updatedAt: { isNull: true } }, { _creationTime: { gt: since } }] }] },
                    ],
                    lockedAt: { isNull: true },
                    title: { isNull: false, ne: "" },
                    userId,
                },
            }),
            // A routine's run threads updated in the window: only a user's reply in one can count.
            repliedRunThreads(ctx, userId, since),
            // Any status: a task that finished (or failed) since the window start is activity, and is in neither overview section.
            // Tasks are deleted outright (no `deleted` column), and `userId` is the owner check the overview uses. `updatedAt` is required.
            ctx.db.tasks.findMany({
                limit: QUIET_TASKS_READ,
                orderBy: [{ updatedAt: "desc" }],
                where: { updatedAt: { gt: since }, userId },
            }),
        ]);

        return {
            events: [
                ...recent.page.map((row) => {
                    return { createdAt: row.createdAt, type: row.type };
                }),
                ...tasks.page.map((task) => {
                    return { createdAt: task.updatedAt, type: TASK_EVENT_TYPE };
                }),
            ],
            // An approval, a coding agent and a sub-agent carry no `updatedAt`: their creation is the time they arose.
            needsYou: [
                ...overview.approvals.map((approval) => {
                    return { at: approval.createdAt, kind: "waiting_in_chat", title: approval.threadTitle ?? "A chat" };
                }),
                ...overview.reviews.map((task) => {
                    return { at: task.updatedAt, kind: "task_review", title: task.title };
                }),
            ],
            running: [
                ...overview.runningTasks.map((task) => {
                    return { at: task.updatedAt, kind: "task", title: task.title };
                }),
                ...overview.codingAgents.map((run) => {
                    return { at: run.createdAt, kind: "coding_agent", title: `${run.repo}: ${run.prompt}` };
                }),
                ...overview.subAgents.map((run) => {
                    return { at: run.createdAt, kind: "sub_agent", title: run.task };
                }),
            ],
            threads: [
                ...chats.page.map((thread) => {
                    return { updatedAt: thread.updatedAt ?? thread._creationTime, ...(thread.title && { title: thread.title }) };
                }),
                ...repliedThreads,
            ],
        };
    });
