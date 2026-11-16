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
import type { AgentState } from "./lib/agent-state";
import { vAcpOptionResult, vAcpSessionStatus, vAgentUsage, vHostEvent } from "./validators";

const BATCH = 200;

/**
 * Sessions read per export page. Lunora charges a page's reads against a 32 MiB transaction limit, and a row's agent state is the
 * largest part of it (the desktop's report, up to about 128 KiB as sent): 50 rows keep one read far below that limit, where 500
 * could exceed it before the byte budget (`SESSION_PAGE_BYTES`) cut the page.
 */
const SESSION_PAGE = 50;

/** The JSON a page of sessions may take, so a page stays far under the 1 MiB a step may keep. */
const SESSION_PAGE_BYTES = 400_000;

/** The UTF-8 bytes a value takes as JSON: the budgets are bytes, so a page of multi-byte text stays under the step's limit. */
const ENCODER = new TextEncoder();
const jsonBytes = (value: unknown): number => ENCODER.encode(JSON.stringify(value)).length;

/** The leading rows whose JSON fits the budget. Always at least one, so a page makes progress. */
const rowsWithinBudget = <Row>(rows: ReadonlyArray<Row>, budget: number): Row[] => {
    const kept: Row[] = [];
    let used = 0;

    for (const row of rows) {
        const size = jsonBytes(row);

        if (kept.length > 0 && used + size > budget) {
            break;
        }

        kept.push(row);
        used += size;
    }

    return kept;
};

/** Chunk rows read per query while scanning a stream for events. */
const CHUNK_PAGE = 200;

/**
 * Rows (streams and chunks) one export page scans, and the bytes of events it returns. A workflow step's result is
 * stored, so a page stays far under the 1 MiB a step may keep; the workflow asks for pages until none is left.
 */
const SCAN_BUDGET = 1000;
const EVENT_BYTES_BUDGET = 400_000;

/**
 * What the export keeps of the agent's state: its usage, and each option's current value. The choices are left out: a list of
 * models can be large enough to fail an export that otherwise fits (`SESSION_PAGE_BYTES`, the export limit).
 */
const vExportAgentState = v.object({
    configOptions: v.optional(v.array(v.object({ category: v.optional(v.string()), currentValue: v.string(), id: v.string(), name: v.string() }))),
    usage: v.optional(vAgentUsage),
});

const vExportSession = v.object({
    agentKey: v.string(),
    agentLabel: v.string(),
    // What the agent reported about its own context use and cost (`session_state`), as the thread's context meter showed it.
    agentState: v.optional(vExportAgentState),
    // When the agent's report was observed: the time the stored values are dated by.
    agentStateAt: v.optional(v.number()),
    capabilities: v.optional(vCapabilityReport),
    createdAt: v.number(),
    folderLabel: v.string(),
    importedTurns: v.optional(v.number()),
    importState: v.optional(v.union(v.literal("importing"), v.literal("done"))),
    lastEventAt: v.optional(v.number()),
    nativeSessionId: v.optional(v.string()),
    // The last option change the person made on this session, and how it ended (`acp/lib/calls.ts`).
    optionResult: v.optional(vAcpOptionResult),
    status: vAcpSessionStatus,
    threadId: v.string(),
});

/**
 * The report without the agent's list of models: it is the agent's offer, not the person's data, and up to 64 entries of a
 * few hundred bytes would push a page past what a workflow step may keep. The model the session ran is in its agent state.
 */
const withoutModelList = (report: Infer<typeof vCapabilityReport>): Infer<typeof vCapabilityReport> => {
    if (report.groups.identity?.models === undefined) {
        return report;
    }

    return { ...report, groups: { ...report.groups, identity: { ...report.groups.identity, models: undefined } } };
};

/** Where the next page starts: in the sessions (`after` and `afterAt` are the last session exported, by its key), or in the host streams' events (`page` is the stream cursor, `seq` the last chunk already read). */
const vExportCursor = v.object({
    // The last session exported, by id and creation time: the next page starts after that key, so a session deleted meanwhile
    // cannot shift the rest.
    after: v.optional(v.string()),
    afterAt: v.optional(v.number()),
    page: v.optional(v.string()),
    phase: v.union(v.literal("sessions"), v.literal("events")),
    seq: v.optional(v.number()),
});

type ExportCursor = Infer<typeof vExportCursor>;

/** Sessions are paged in creation order, the id breaking a tie in the creation time, so the key of a session is total. */
const compareSessionKeys = (a: { _creationTime: number; _id: string }, b: { _creationTime: number; _id: string }): number => {
    if (a._creationTime !== b._creationTime) {
        return a._creationTime - b._creationTime;
    }

    if (a._id === b._id) {
        return 0;
    }

    return a._id < b._id ? -1 : 1;
};

/** Whether a session comes after the key (creation time, then id) of the last one exported. */
const isAfterKey = (row: { _creationTime: number; _id: string }, at: number, id: string): boolean =>
    row._creationTime > at || (row._creationTime === at && row._id > id);

/** The export's share of an agent state (`vExportAgentState`): usage and each option's current value, without its choices. */
const exportedAgentState = (state: AgentState): Infer<typeof vExportAgentState> => {
    return {
        ...(state.configOptions !== undefined && {
            configOptions: state.configOptions.map(({ category, currentValue, id, name }) => {
                return { ...(category !== undefined && { category }), currentValue, id, name };
            }),
        }),
        ...(state.usage !== undefined && { usage: state.usage }),
    };
};

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
            // Keyset paging: the page starts after the last session exported, by its creation time and id. A position counted
            // from the start would move when a session before it is deleted, and skip one.
            const after = cursor?.after;
            const afterAt = cursor?.afterAt;
            const fetched = await ctx.db.acpSessions.findMany({
                limit: SESSION_PAGE,
                orderBy: [{ _creationTime: "asc" }],
                where: { userId, ...(afterAt !== undefined && { _creationTime: { gte: afterAt } }) },
            });
            const pending = (
                after === undefined || afterAt === undefined ? fetched.page : fetched.page.filter((row) => isAfterKey(row, afterAt, after))
            ).toSorted(compareSessionKeys);

            // Labels and times only: no device id, no path ever reaches the backend.
            const rows = pending.map(
                ({
                    agentKey,
                    agentLabel,
                    agentState,
                    agentStateAt,
                    capabilities,
                    createdAt,
                    folderLabel,
                    importedTurns,
                    importState,
                    lastEventAt,
                    nativeSessionId,
                    optionResult,
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
                        ...(agentState !== undefined && { agentState: exportedAgentState(agentState) }),
                        ...(agentStateAt !== undefined && { agentStateAt }),
                        ...(capabilities !== undefined && { capabilities: withoutModelList(capabilities) }),
                        ...(importedTurns !== undefined && { importedTurns }),
                        ...(importState !== undefined && { importState }),
                        ...(lastEventAt !== undefined && { lastEventAt }),
                        ...(nativeSessionId !== undefined && { nativeSessionId }),
                        ...(optionResult !== undefined && { optionResult }),
                    };
                },
            );

            // A row can hold up to 128 KiB of agent state, so a page is also cut by bytes: the rest of the rows come next, after
            // the last one taken. A full page may have rows after it too.
            const sessions = rowsWithinBudget(rows, SESSION_PAGE_BYTES);
            const lastTaken = pending[sessions.length - 1];
            const more = lastTaken !== undefined && (sessions.length < pending.length || fetched.page.length === SESSION_PAGE);

            return {
                events: [],
                next: more ? { after: lastTaken._id, afterAt: lastTaken._creationTime, phase: "sessions" as const } : { phase: "events" as const },
                sessions,
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

                const size = jsonBytes(event);

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

        bytes += jsonBytes(page);

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

        await Promise.all(page.map(async (row) => await ctx.db.delete("acpSessions", row._id)));

        return { hasMore: page.length >= BATCH };
    });
