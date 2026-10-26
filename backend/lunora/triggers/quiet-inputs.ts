/**
 * The read behind a quiet routine's decision (`quiet.ts`).
 *
 * Not `loadDailyBriefInputs`: that one drops every timestamp, and a quiet
 * routine must tell an open request from last week from a new one. It reads the
 * same sources (`loadHomeOverview` and the user's notifications), except for
 * chats: `loadHomeOverview` keeps only the six most recently updated, so a
 * handful of routine runs updating threads after a user's chat would push that
 * chat out of view. Chats are read here by their own windowed query instead.
 */
import { v } from "lunorash/server";

import { internalQuery } from "../_generated/server";
import { loadHomeOverview } from "../home/overview";
import type { QuietSnapshot } from "./quiet";
import { QUIET_IGNORED_EVENT_TYPES, TRIGGER_THREAD_TAG } from "./quiet";

/** Notifications read, as the brief reads them. */
const QUIET_EVENTS_READ = 50;

/** Chats read: the decision needs one, and the rest only fill the brief's list of titles. */
const QUIET_THREADS_READ = 20;

/** A column an old row may leave unset, or set to false. */
const notSet = (field: "deleted" | "isTemporary") => {
    return { OR: [{ [field]: { isNull: true } }, { [field]: false }] };
};

const vItem = v.object({ at: v.number(), kind: v.string(), title: v.string() });

export const loadQuietSnapshot = internalQuery
    .input({ since: v.number(), userId: v.string() })
    .output(
        v.object({
            events: v.array(v.object({ createdAt: v.number(), type: v.string() })),
            needsYou: v.array(vItem),
            running: v.array(vItem),
            threads: v.array(v.object({ title: v.optional(v.string()), updatedAt: v.number() })),
        }),
    )
    .query(async ({ args: { since, userId }, ctx }): Promise<QuietSnapshot> => {
        const [overview, recent, chats] = await Promise.all([
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
            // A locked or untitled chat never counts. A row with no `updatedAt` is dated by its creation, as the home view does.
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
                    title: { isNull: false },
                    userId,
                },
            }),
        ]);

        return {
            events: recent.page.map((row) => {
                return { createdAt: row.createdAt, type: row.type };
            }),
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
            threads: chats.page.map((thread) => {
                return { updatedAt: thread.updatedAt ?? thread._creationTime, ...(thread.title && { title: thread.title }) };
            }),
        };
    });
