/**
 * Coding-agent sessions and host events in the GDPR export and account deletion. Wired into
 * `gdpr/steps.ts#generateExportFile` (paged) and `gdpr/workflows/deletion-workflow.ts`
 * ("delete-user-acp-sessions"). The threads, messages, streams and chunks of a host-run thread are the ordinary rows
 * the other steps already erase (a host stream carries its user's id, so `erasePersistentStreamsForUser` reaches it
 * and every chunk).
 * Deletion follows the residual steps' contract: at most `BATCH` rows per call, `{ hasMore }` back, idempotent
 * on retry.
 */
import type { Infer } from "lunorash/server";
import { LunoraError, v } from "lunorash/server";

import type { Doc } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { internalMutation, internalQuery } from "../_generated/server";
import { vCapabilityReport } from "../lib/capability-report";
import { vAcpSessionStatus, vHostEvent } from "./validators";

const BATCH = 200;

/** Sessions per export page: a row is a few hundred bytes. */
const SESSION_PAGE = 500;

/** Chunk rows read per query while scanning a stream for events. */
const CHUNK_PAGE = 200;

/**
 * Rows (streams and chunks) one export page scans, and the bytes of events it returns. A workflow step's result is
 * stored, so a page stays far under the 1 MiB a step may keep; the workflow asks for pages until none is left.
 */
const SCAN_BUDGET = 1000;
const EVENT_BYTES_BUDGET = 400_000;

const vExportSession = v.object({
    agentKey: v.string(),
    agentLabel: v.string(),
    capabilities: v.optional(vCapabilityReport),
    createdAt: v.number(),
    folderLabel: v.string(),
    importedTurns: v.optional(v.number()),
    importState: v.optional(v.union(v.literal("importing"), v.literal("done"))),
    lastEventAt: v.optional(v.number()),
    nativeSessionId: v.optional(v.string()),
    status: vAcpSessionStatus,
    threadId: v.string(),
});

/** Where the next page starts: in the sessions (`page` is the table cursor), or in the host streams' events (`page` is the stream cursor, `seq` the last chunk already read). */
const vExportCursor = v.object({
    page: v.optional(v.string()),
    phase: v.union(v.literal("sessions"), v.literal("events")),
    seq: v.optional(v.number()),
});

type ExportCursor = Infer<typeof vExportCursor>;

/**
 * One page of a user's coding-agent export: sessions first, then the tool, permission and turn-end events of their
 * host turns (the prompt and the saved reply are ordinary messages, exported with the conversations), and the text
 * and reasoning the agent streamed (the saved reply can be cut short, or missing for a deleted thread). `next` is
 * absent on the last page. `generateExportFile` asks again with `next` until it is, so a long history is complete
 * and no single call or query result holds more than a page.
 */
export const collectAcpSessionsForExport = internalQuery
    .input({ cursor: v.optional(vExportCursor), userId: v.string() })
    .output(
        v.object({
            events: v.array(v.object({ event: vHostEvent, seq: v.number(), threadId: v.string(), turnId: v.string() })),
            next: v.optional(vExportCursor),
            sessions: v.array(vExportSession),
        }),
    )
    .query(async ({ args: { cursor, userId }, ctx }) => {
        if (cursor === undefined || cursor.phase === "sessions") {
            const { continueCursor, isDone, page } = await ctx.db.acpSessions.findMany({ cursor: cursor?.page, limit: SESSION_PAGE, where: { userId } });

            return {
                events: [],
                next: isDone ? { phase: "events" as const } : { page: continueCursor ?? undefined, phase: "sessions" as const },
                // Labels and times only: no device id, no path ever reaches the backend.
                sessions: page.map(
                    ({
                        agentKey,
                        agentLabel,
                        capabilities,
                        createdAt,
                        folderLabel,
                        importedTurns,
                        importState,
                        lastEventAt,
                        nativeSessionId,
                        status,
                        threadId,
                    }) => {
                        return {
                            agentKey,
                            agentLabel,
                            createdAt,
                            folderLabel,
                            status,
                            threadId: threadId as string,
                            ...(capabilities !== undefined && { capabilities }),
                            ...(importedTurns !== undefined && { importedTurns }),
                            ...(importState !== undefined && { importState }),
                            ...(lastEventAt !== undefined && { lastEventAt }),
                            ...(nativeSessionId !== undefined && { nativeSessionId }),
                        };
                    },
                ),
            };
        }

        const { events, next } = await collectHostEvents(ctx, userId, cursor);

        return { events, sessions: [], ...(next !== undefined && { next }) };
    });

type EventRecord = { event: Infer<typeof vHostEvent>; seq: number; threadId: string; turnId: string };

/**
 * A chunk as the event the desktop posted. Text and reasoning are the chunk's own fields, not an `event`: exported
 * all the same, because the saved reply is cut when a turn is long and there is none when the thread was deleted
 * mid-turn, so the chunks are the only full record of what the agent said.
 */
const eventOf = (chunk: Pick<Doc<"persistentChunks">, "event" | "reasoning" | "text">): EventRecord["event"] | undefined => {
    if (chunk.event !== undefined) {
        return chunk.event;
    }

    if (chunk.reasoning) {
        return { kind: "reasoning", text: chunk.reasoning };
    }

    return chunk.text ? { kind: "text", text: chunk.text } : undefined;
};

/** Walks the user's host streams from `cursor`, one chunk page at a time, until the page's budget is spent. */
const collectHostEvents = async (ctx: QueryCtx, userId: string, cursor: ExportCursor): Promise<{ events: EventRecord[]; next?: ExportCursor }> => {
    const events: EventRecord[] = [];
    let streamCursor = cursor.page;
    let afterSeq = cursor.seq ?? -1;
    let scanned = 0;
    let bytes = 0;

    for (;;) {
        const streams = await ctx.db.persistentStreams.findMany({ cursor: streamCursor, limit: 1, where: { producer: "host", userId } });
        const [stream] = streams.page;

        if (!stream) {
            return { events };
        }

        scanned += 1;

        for (;;) {
            const { page } = await ctx.db.persistentChunks.findMany({
                limit: CHUNK_PAGE,
                orderBy: [{ seq: "asc" }],
                where: { seq: { gt: afterSeq }, streamId: stream._id },
            });

            for (const chunk of page) {
                const event = eventOf(chunk);

                // The turn's prompt is its first chunk's placeholder (the text is the user's message).
                if (event === undefined || event.kind === "turn_start") {
                    continue;
                }

                const size = JSON.stringify(event).length;

                // A page always takes its first event, so one over the budget by itself still goes out.
                if (events.length > 0 && bytes + size > EVENT_BYTES_BUDGET) {
                    return { events, next: { page: streamCursor, phase: "events", seq: chunk.seq - 1 } };
                }

                bytes += size;
                events.push({ event, seq: chunk.seq, threadId: stream.threadId as string, turnId: stream.hostTurnId ?? "" });
            }

            scanned += page.length;
            afterSeq = page.at(-1)?.seq ?? afterSeq;

            if (page.length < CHUNK_PAGE) {
                break;
            }

            if (scanned >= SCAN_BUDGET) {
                return { events, next: { page: streamCursor, phase: "events", seq: afterSeq } };
            }
        }

        if (streams.isDone) {
            return { events };
        }

        streamCursor = streams.continueCursor ?? undefined;
        afterSeq = -1;

        if (scanned >= SCAN_BUDGET) {
            return { events, next: { page: streamCursor, phase: "events" } };
        }
    }
};

/**
 * Every page of the export, asked one after the other with the cursor each answer names, held to `maxBytes` in
 * total. The caller reads them while it writes the file, so the history is never an argument or a stored step result.
 */
export const collectAcpSessionPages = async (
    readPage: (cursor: ExportCursor | undefined) => Promise<{ events: unknown[]; next?: ExportCursor; sessions: unknown[] }>,
    maxBytes: number,
): Promise<{ events: unknown[]; sessions: unknown[] }> => {
    const collected: { events: unknown[]; sessions: unknown[] } = { events: [], sessions: [] };
    let cursor: ExportCursor | undefined;
    let bytes = 0;

    do {
        const page = await readPage(cursor);

        bytes += JSON.stringify(page).length;

        if (bytes > maxBytes) {
            throw new LunoraError("PAYLOAD_TOO_LARGE", "The coding-agent history is larger than the export limit");
        }

        collected.sessions.push(...page.sessions);
        collected.events.push(...page.events);
        cursor = page.next;
    } while (cursor !== undefined);

    return collected;
};

export const deleteUserAcpSessions = internalMutation
    .input({ userId: v.string() })
    .output(v.object({ hasMore: v.boolean() }))
    .mutation(async ({ args: { userId }, ctx }) => {
        const { page } = await ctx.db.acpSessions.findMany({ limit: BATCH, where: { userId } });

        await Promise.all(page.map(async (row) => await ctx.db.delete(row._id)));

        return { hasMore: page.length >= BATCH };
    });
