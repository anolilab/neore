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
import { withoutUndefined } from "../lib/patch";
import { agentSwitchRowContent } from "./agent-switch-logic";
import type { AgentSwitchPart } from "./agent-switch-validators";
import type { VectorTableName } from "./vector/tables";

type Database = MutationCtx["db"];
type NewRow<T extends "messages" | "threadRelationships" | "threads"> = Omit<Doc<T>, "_creationTime" | "_id">;

/** The `threads` columns other modules set. */
export type ThreadPatch = Partial<
    Pick<
        Doc<"threads">,
        "activeAgent" | "activeLeafMessageId" | "groupChat" | "lastCompressionStartedAt" | "model" | "status" | "tagIds" | "updatedAt" | "workerPolicy"
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

export const patchThread = async (db: Database, threadId: Id<"threads">, fields: ThreadPatch): Promise<void> => {
    await db.patch(threadId, withoutUndefined(fields));
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
    row: { order: number; parentMessageId?: string; part: AgentSwitchPart; threadId: Id<"threads">; userId: string },
): Promise<Id<"messages">> => {
    const { message, providerMetadata } = agentSwitchRowContent(row.part);

    return await insertMessageRow(db, {
        message,
        order: row.order,
        parentMessageId: row.parentMessageId,
        providerMetadata,
        status: "success",
        stepOrder: 0,
        threadId: row.threadId,
        tool: false,
        userId: row.userId,
    });
};

/** Rewrites the part of a divider written by `insertAgentSwitchRow`, checked the same way. */
export const patchAgentSwitchRow = async (db: Database, messageId: Id<"messages">, part: AgentSwitchPart): Promise<void> => {
    await db.patch(messageId, { providerMetadata: agentSwitchRowContent(part).providerMetadata });
};

export const patchMessage = async (db: Database, messageId: Id<"messages">, fields: MessagePatch): Promise<void> => {
    await db.patch(messageId, withoutUndefined(fields));
};

export const patchTemporaryThread = async (db: Database, rowId: Id<"temporaryThreads">, fields: TemporaryThreadPatch): Promise<void> => {
    await db.patch(rowId, withoutUndefined(fields));
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

    await Promise.all(markers.map((marker) => db.patch(marker._id, { expiresAt })));
};

export const insertChatFileAccess = async (db: Database, fileId: Id<"chatFiles">, userId: string): Promise<void> => {
    await db.insert("chatFileAccess", { createdAt: Date.now(), fileId, userId });
};

/** Delete one vector row (`agent/vector`), e.g. a memory's embedding. */
export const deleteVectorRow = async (db: Database, vectorId: Id<VectorTableName>): Promise<void> => {
    await db.delete(vectorId);
};
