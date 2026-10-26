/**
 * The read behind a quiet routine's decision (`quiet.ts`).
 *
 * Not `loadDailyBriefInputs`: that one drops every timestamp, and a quiet
 * routine must tell an open request from last week from a new one. It reads the
 * same sources (`loadHomeOverview` and the user's notifications) and leaves the
 * windowing and the exclusions to the pure `quietBriefInputs`.
 */
import { v } from "lunorash/server";

import { internalQuery } from "../_generated/server";
import { loadHomeOverview } from "../home/overview";
import type { QuietSnapshot } from "./quiet";
import { QUIET_IGNORED_EVENT_TYPES } from "./quiet";

/** Notifications read, as the brief reads them. */
const QUIET_EVENTS_READ = 50;

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
        const [overview, recent] = await Promise.all([
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
            threads: overview.recentThreads.map((thread) => {
                return { updatedAt: thread.updatedAt, ...(thread.title && { title: thread.title }) };
            }),
        };
    });
