/**
 * The agent module's write surface for OTHER modules.
 *
 * `agent/module.ts` owns `threads`, `messages` and the rows hanging off them,
 * so the `cross_module_table_write` advisor flags any other module writing them
 * directly. Feature modules still annotate those rows (a group chat's
 * participants, a reply's knowledge sources, a thread's tags) — they do it
 * through these functions, which is what lets this module see every column
 * written from outside it in one place. The patch types below ARE that list:
 * widening one is a decision about this module's tables, made here.
 *
 * Plain functions over `ctx.db`, not procedures, on purpose: a caller's write
 * stays inside ITS mutation's transaction (a `ctx.runMutation` would be a
 * separate one, and a mutation has no `runMutation` anyway), on the same
 * shard, through the same RLS-guarded `ctx.db` it was handed. Moving a write
 * here therefore changes nothing at runtime.
 *
 * Patches go through `withoutUndefined`: an `undefined` value means "leave the
 * column unchanged". To REMOVE a column, use `patchById` (`lib/patch.ts`) in
 * this module instead.
 */
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { patchRow, withoutUndefined } from "../lib/patch";
import { agentSwitchRowContent } from "./agent-switch-logic";
import type { AgentSwitchPart } from "./agent-switch-validators";
import { findVectorTable, type VectorTableName } from "./vector/tables";

type Database = MutationCtx["db"];
type NewRow<T extends "messages" | "threadRelationships" | "threads"> = Omit<Doc<T>, "_creationTime" | "_id">;

/** The `threads` columns other modules set. */
export type ThreadPatch = Partial<
    Pick<
        Doc<"threads">,
        | "activeAgent"
        | "activeLeafMessageId"
        | "autoModel"
        | "awaitingInput"
        | "groupChat"
        | "hasHandoff"
        | "lastCompressionStartedAt"
        | "lastReplyAt"
        | "model"
        | "status"
        | "tagIds"
        | "updatedAt"
        | "workerPolicy"
    >
>;

/** The `messages` columns other modules set. */
export type MessagePatch = Partial<
    Pick<Doc<"messages">, "agentName" | "fileIds" | "message" | "retrievedMemories" | "sources" | "speakerSkillId" | "status" | "text">
>;

/** The `temporaryThreads` columns other modules set. */
export type TemporaryThreadPatch = Partial<Pick<Doc<"temporaryThreads">, "skillDraft">>;

/** A thread created outside the chat start path (group chats, local models, messenger, imports). */
export const insertThread = async (db: Database, row: NewRow<"threads">): Promise<Id<"threads">> =>
    await db.insert("threads", { ...row, createdAt: row.createdAt ?? Date.now() });

/**
 * The row a write that puts a thread back to `running`, or records a finished reply (`lastReplyAt`), must leave:
 * `awaitingInput` belongs to the pause that just ended. Every such write funnels through here or `agent/threads.ts#updateThread`, so no call site has to
 * remember to clear it.
 */
export const patchesWithoutAwaitingInput = (
    row: Pick<Doc<"threads">, "awaitingInput"> | null,
    fields: Pick<ThreadPatch, "awaitingInput" | "lastReplyAt" | "status">,
): boolean => (fields.status === "running" || fields.lastReplyAt !== undefined) && fields.awaitingInput === undefined && row?.awaitingInput !== undefined;

/**
 * The one wake rule: a write that pauses for the owner (an approval or a question), or that fails. The owner should not have
 * to find the thread in Snoozed to answer it, or to learn that it broke. `patchThread` reads the row only for a write this
 * rule admits, so both of its uses must share this definition.
 */
const fieldsWake = (fields: Pick<ThreadPatch, "awaitingInput" | "status">, failed: boolean): boolean =>
    fields.awaitingInput !== undefined || fields.status === "error" || failed;

export const patchesWakeSnooze = (
    row: Pick<Doc<"threads">, "snoozedUntil"> | null,
    fields: Pick<ThreadPatch, "awaitingInput" | "status">,
    failed = false,
): boolean => row?.snoozedUntil !== undefined && fieldsWake(fields, failed);

/**
 * The one writer of a thread's run state. A write that ends a pause or records a reply removes `awaitingInput`
 * (`patchesWithoutAwaitingInput`); a write that pauses for the owner or fails also removes a snooze
 * (`patchesWakeSnooze`). Both happen in the same patch, so a thread never shows as snoozed while it waits on a person.
 */
export const patchThread = async (db: Database, threadId: Id<"threads">, fields: ThreadPatch, { failed = false }: { failed?: boolean } = {}): Promise<void> => {
    const endsPause = fields.status === "running" || fields.lastReplyAt !== undefined;
    const wakes = fieldsWake(fields, failed);

    if (endsPause || wakes) {
        const row = await db.get("threads", threadId);

        if (row) {
            const clearsAwaiting = endsPause && patchesWithoutAwaitingInput(row, fields);
            const clearsSnooze = patchesWakeSnooze(row, fields, failed);

            // A wake is recorded as the thread's ordering even when there is no snooze to clear: a snooze chosen before it is older
            // than the wake, and must not hide the thread again when it drains (`isStaleSnoozeChoice`).
            if (clearsAwaiting || clearsSnooze || wakes) {
                await patchRow(db, "threads", row, {
                    ...withoutUndefined(fields),
                    ...(clearsAwaiting && { awaitingInput: undefined }),
                    ...(clearsSnooze && { snoozedUntil: undefined }),
                    ...(wakes && { snoozeChosenAt: Date.now() }),
                });

                return;
            }
        }
    }

    await db.patch("threads", threadId, withoutUndefined(fields));
};

/** Removes `awaitingInput` from a thread whose pause can no longer be answered (its approval snapshot expired). */
export const clearAwaitingInput = async (db: Database, threadId: Id<"threads">): Promise<void> => {
    const row = await db.get("threads", threadId);

    if (row?.awaitingInput !== undefined) {
        await patchRow(db, "threads", row, { awaitingInput: undefined });
    }
};

/**
 * Records that the OWNER has seen the thread's latest reply. Leaves `updatedAt` alone (the lists sort by it) and
 * writes nothing when there is no reply newer than the last view. Returns whether it wrote.
 */
export const markThreadViewedAt = async (db: Database, thread: Doc<"threads">, now: number): Promise<boolean> => {
    if (thread.lastReplyAt === undefined || (thread.lastViewedAt !== undefined && thread.lastViewedAt >= thread.lastReplyAt)) {
        return false;
    }

    await db.patch("threads", thread._id, { lastViewedAt: now });

    return true;
};

/**
 * Whether a snooze write is stale, so it changes nothing. `chosenAt` is when the owner made the choice, by the client's clock; the
 * thread's `snoozeChosenAt` is the newest ordering it has seen (a choice, or a wake). Once a thread has an ordering, a choice chosen
 * before it is stale. So a queued write cannot undo a newer choice or re-hide a thread that has since woken, and another device's
 * earlier write cannot undo a later one.
 */
export const isStaleSnoozeChoice = (thread: Pick<Doc<"threads">, "snoozeChosenAt">, chosenAt: number): boolean =>
    thread.snoozeChosenAt !== undefined && chosenAt < thread.snoozeChosenAt;

/**
 * Sets the thread's snooze: `until`, or `undefined` to bring it back, and records `chosenAt` as the ordering. Leaves `updatedAt` alone.
 * A stale write (`isStaleSnoozeChoice`) changes nothing.
 */
export const setThreadSnooze = async (db: Database, thread: Doc<"threads">, until: number | undefined, chosenAt: number): Promise<void> => {
    if (isStaleSnoozeChoice(thread, chosenAt)) {
        return;
    }

    if (until === undefined) {
        if (thread.snoozedUntil !== undefined || thread.snoozeChosenAt !== chosenAt) {
            await patchRow(db, "threads", thread, { snoozeChosenAt: chosenAt, snoozedUntil: undefined });
        }

        return;
    }

    await patchRow(db, "threads", thread, { snoozeChosenAt: chosenAt, snoozedUntil: until });
};

/**
 * A message row written straight to the table, NOT through `addMessagesHandler`
 * (no branch parent, no leaf advance, no embedding) — what messenger and the
 * chat import have always done. Prefer `addMessagesHandler` for anything new.
 */
export const insertMessageRow = async (db: Database, row: NewRow<"messages">): Promise<Id<"messages">> =>
    await db.insert("messages", { ...row, createdAt: row.createdAt ?? Date.now() });

/**
 * The row that records an agent switch: a `system` row with no text (`agent-switch-logic.ts`),
 * checked against `vAgentSwitch` before it is written. The only writer of one, so a reader can
 * trust that a row carrying the marker holds a well-formed part.
 *
 * `parentMessageId` is the row the switch follows. Leave it out in a thread that never
 * branched, where the previous row is the parent already.
 */
export const insertAgentSwitchRow = async (
    db: Database,
    row: { order: number; parentMessageId?: string; part: AgentSwitchPart; stepOrder?: number; threadId: Id<"threads">; userId: string },
): Promise<Id<"messages">> => {
    const { message, providerMetadata } = agentSwitchRowContent(row.part);

    return await insertMessageRow(db, {
        message,
        order: row.order,
        parentMessageId: row.parentMessageId,
        providerMetadata,
        status: "success",
        stepOrder: row.stepOrder ?? 0,
        threadId: row.threadId,
        tool: false,
        userId: row.userId,
    });
};

/** Rewrites the part of a divider written by `insertAgentSwitchRow`, checked the same way. */
export const patchAgentSwitchRow = async (db: Database, messageId: Id<"messages">, part: AgentSwitchPart): Promise<void> => {
    await db.patch("messages", messageId, { providerMetadata: agentSwitchRowContent(part).providerMetadata });
};

export const patchMessage = async (db: Database, messageId: Id<"messages">, fields: MessagePatch): Promise<void> => {
    await db.patch("messages", messageId, withoutUndefined(fields));
};

export const patchTemporaryThread = async (db: Database, rowId: Id<"temporaryThreads">, fields: TemporaryThreadPatch): Promise<void> => {
    await db.patch("temporaryThreads", rowId, withoutUndefined(fields));
};

export const insertThreadRelationship = async (db: Database, row: NewRow<"threadRelationships">): Promise<Id<"threadRelationships">> =>
    await db.insert("threadRelationships", row);

/** Grant `userId` read access to a stored chat file (a fork handing over the author's files). */
/**
 * Moves the expiry of a thread's marker rows to `expiresAt`. The expiry cron uses
 * this as a lease while it deletes the thread (`deleteExpiredTemporaryChats`), so
 * the marker is not selected again until the lease runs out.
 */
export const leaseTemporaryThreadMarkers = async (db: Database, threadId: Id<"threads">, expiresAt: number): Promise<void> => {
    const markers = await db
        .query("temporaryThreads")
        .withIndex("by_thread", (q) => q.eq("threadId", threadId))
        .collect();

    await Promise.all(markers.map((marker) => db.patch("temporaryThreads", marker._id, { expiresAt })));
};

export const insertChatFileAccess = async (db: Database, fileId: Id<"chatFiles">, userId: string): Promise<void> => {
    await db.insert("chatFileAccess", { createdAt: Date.now(), fileId, userId });
};

/**
 * Delete one vector row (`agent/vector`), e.g. a memory's embedding. A caller that already knows the row's
 * table passes it, which skips the probe.
 */
export const deleteVectorRow = async (db: Database, vectorId: Id<VectorTableName>, knownTable?: VectorTableName): Promise<void> => {
    const table = knownTable ?? (await findVectorTable(db, vectorId));

    if (table !== null) {
        await db.delete(table, vectorId);
    }
};
