/**
 * The owner's group chats by the skills they name: `groupChatSkills`, one row per (thread, skill), kept in step with
 * `threads.groupChat` by the `threads` triggers below, so "does one of this owner's group chats use this skill" is an index
 * read, not a scan of the owner's newest 300 chats.
 *
 * An index is trusted only for an owner whose `groupChatSkillIndex` row says it is complete: the backfill
 * (`skill-index-backfill.ts`) marks that once it has walked every thread the owner had. Until then callers keep their bounded
 * scan. A row set by a trigger that failed would leave a stale index behind a set mark, so the triggers throw and fail the
 * thread write; they never log and go on.
 *
 * Imported by `schema.ts`: it must not import `_generated` at runtime.
 */
import type { TriggerBuilder, TriggerCtx } from "lunorash/server";

import type { Doc } from "../../_generated/dataModel";
import type { QueryCtx } from "../../_generated/server";

/** Most rows one thread's reconcile reads: far over a group's participant cap. */
const ROWS_PER_THREAD = 500;

/** Rows read for one skill before the answer is "unknown": a bound, so one popular skill cannot make a read unbounded. */
export const ROWS_PER_SKILL = 100;

interface StoredRow {
    _id: string;
    skillId: string;
    userId: string;
}

/** Where the rows are read and written: the trigger's database, or a mutation's. */
interface IndexStore {
    insert: (row: { skillId: string; threadId: string; userId: string }) => Promise<void>;
    list: (threadId: string) => Promise<StoredRow[]>;
    remove: (id: string) => Promise<void>;
}

type GroupChat = Doc<"threads">["groupChat"];

/** The skill ids a group chat names, each once: its participants, then a synthesizer that is not one of them. */
export const groupSkillIds = (groupChat: GroupChat): string[] => {
    if (!groupChat) {
        return [];
    }

    const ids = new Set(groupChat.participants.map((participant) => participant.skillId));

    if (groupChat.synthesizerSkillId !== undefined) {
        ids.add(groupChat.synthesizerSkillId);
    }

    return [...ids];
};

interface ThreadFields {
    groupChat?: GroupChat;
    userId?: string;
}

/** What the index holds for a thread: its owner and the skill ids, sorted. A write that leaves it as it was touches nothing. */
const indexKey = (thread: ThreadFields | undefined): string =>
    thread?.userId === undefined ? "" : JSON.stringify([thread.userId, groupSkillIds(thread.groupChat).toSorted((a, b) => a.localeCompare(b))]);

const hasIds = (thread: ThreadFields | undefined): boolean => indexKey(thread) !== "" && groupSkillIds(thread?.groupChat).length > 0;

/**
 * Makes the thread's rows equal what it names now: rows for a skill it dropped (or another owner) go, a missing one is added.
 * Not a delta, so a thread half-indexed before a backfill reached it comes out right, and running it twice changes nothing.
 */
export const reconcileThreadIndex = async (store: IndexStore, threadId: string, thread: ThreadFields): Promise<void> => {
    const wanted = thread.userId === undefined ? [] : groupSkillIds(thread.groupChat);
    const kept = new Set<string>();

    const existing = await store.list(threadId);

    for (const row of existing) {
        if (row.userId !== thread.userId || !wanted.includes(row.skillId) || kept.has(row.skillId)) {
            await store.remove(row._id);
        } else {
            kept.add(row.skillId);
        }
    }

    for (const skillId of wanted) {
        if (!kept.has(skillId) && thread.userId !== undefined) {
            await store.insert({ skillId, threadId, userId: thread.userId });
        }
    }
};

const triggerStore = (context: TriggerCtx): IndexStore => {
    return {
        insert: async (row) => {
            await context.db.insert("groupChatSkills", row);
        },
        list: async (threadId) => {
            const { page } = await context.db.findMany("groupChatSkills", { limit: ROWS_PER_THREAD, where: { threadId } });

            return page as unknown as StoredRow[];
        },
        remove: async (id) => {
            await context.db.delete("groupChatSkills", id);
        },
    };
};

/**
 * The `threads` triggers. Each is a no-op, with no read, unless the thread's owner or skill ids changed: a thread is written
 * on every reply, and nearly none of those writes touch a group's participants.
 */
export const groupSkillIndexTriggers = (t: TriggerBuilder) => {
    return {
        groupSkillIndexDelete: t.afterDelete(async (context, event) => {
            const previous = event.previous as unknown as ThreadFields;

            if (hasIds(previous)) {
                await reconcileThreadIndex(triggerStore(context), event.id, { userId: previous.userId });
            }
        }),
        groupSkillIndexInsert: t.afterInsert(async (context, event) => {
            const doc = event.doc as unknown as ThreadFields;

            if (hasIds(doc)) {
                await reconcileThreadIndex(triggerStore(context), event.id, doc);
            }
        }),
        groupSkillIndexUpdate: t.afterUpdate(async (context, event) => {
            const previous = event.previous as unknown as ThreadFields;
            const doc = event.doc as unknown as ThreadFields;

            if (indexKey(previous) !== indexKey(doc)) {
                await reconcileThreadIndex(triggerStore(context), event.id, doc);
            }
        }),
    };
};

/** A mutation's view of the rows, for the backfill. */
export const mutationStore = (ctx: { db: any }): IndexStore => {
    return {
        insert: async (row) => {
            await ctx.db.insert("groupChatSkills", row);
        },
        list: async (threadId) => {
            const { page } = await ctx.db.groupChatSkills.findMany({ limit: ROWS_PER_THREAD, where: { threadId } });

            return page as StoredRow[];
        },
        remove: async (id) => {
            await ctx.db.delete("groupChatSkills", id);
        },
    };
};

/** Whether the owner's index covers every group chat they have, so a read of it may stand in for the scan. */
export const ownerIndexComplete = async (ctx: Pick<QueryCtx, "db">, userId: string): Promise<boolean> => {
    const state = await ctx.db.groupChatSkillIndex.findFirst({ where: { userId } });

    return state?.completedAt !== undefined;
};

/** Whether one of the owner's group chats names the skill, when the owner's index is complete; `undefined` when it is not. */
export const indexedGroupNames = async (ctx: Pick<QueryCtx, "db">, userId: string, skillId: string): Promise<boolean | undefined> => {
    if (!(await ownerIndexComplete(ctx, userId))) {
        return undefined;
    }

    const row = await ctx.db.groupChatSkills.findFirst({ where: { skillId, userId } });

    return row !== null;
};

/**
 * The owner's group chats that name any of `skillIds` as a participant, other than the plugin's own (`exceptInstallId`), read from the
 * index. `unknown` is true when the answer cannot be trusted: a skill named by more chats than {@link ROWS_PER_SKILL}, or a row whose
 * thread is gone. Callers treat it as "may be used" (keep and detach), as they do for a scan that fills its page. `undefined` when the
 * owner's index is not complete: the caller scans.
 */
export const indexedGroupUsers = async (
    ctx: Pick<QueryCtx, "db">,
    userId: string,
    skillIds: ReadonlyArray<string>,
    exceptInstallId: string,
): Promise<{ unknown: boolean; users: Doc<"threads">[] } | undefined> => {
    if (!(await ownerIndexComplete(ctx, userId))) {
        return undefined;
    }

    const users = new Map<string, Doc<"threads">>();
    let unknown = false;

    for (const skillId of skillIds) {
        const { page } = await ctx.db.groupChatSkills.findMany({ limit: ROWS_PER_SKILL + 1, where: { skillId, userId } });

        unknown ||= page.length > ROWS_PER_SKILL;

        for (const row of page.slice(0, ROWS_PER_SKILL)) {
            const thread = await ctx.db.get("threads", row.threadId as Doc<"threads">["_id"]);

            if (!thread) {
                unknown = true;
            } else if (thread.pluginInstallId !== exceptInstallId && thread.groupChat?.participants.some((participant) => participant.skillId === skillId)) {
                users.set(thread._id as string, thread);
            }
        }
    }

    return { unknown, users: [...users.values()] };
};
