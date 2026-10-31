/**
 * Importing an agent's saved session as a host thread (plans/acp-agent-host.md S6).
 *
 * - {@link openImport} finds the session an agent session already has here, or makes the thread and a session
 *   that waits for its transcript. The lookup is by `(user, agentKey, nativeSessionId)` in the same mutation that
 *   inserts, and a shard runs one mutation at a time, so two imports of one session, however they interleave,
 *   leave one thread. It is also found when the session ran here (a live session records its native id).
 * - {@link applyImportTurns} writes the transcript a turn at a time. The claim is `importedTurns`, as `(turnId,
 *   seq)` is for a live turn: a turn at or below it is dropped, a post that starts past it answers `gap`, so a
 *   resend or a second importer writes nothing twice.
 *
 * The imported session is `ended`: no agent runs on this computer for it. The native id stays on the row for the
 * reattach that comes later. Rows are written through the same surface a live turn uses (`addMessagesHandler`,
 * `buildHostReply`); like a live turn, an import creates no usage row and charges no credit.
 */
import type { Infer } from "lunorash/server";

import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { addMessagesHandler } from "../../agent/messages";
import { insertThread } from "../../agent/table-writes";
import { MAX_LENGTH } from "../../lib/validators";
import type { vHostEvent } from "../validators";
import { MAX_IMPORT_TURNS, MAX_IMPORT_TURNS_PER_POST } from "./constants";
import { isHostRunThread } from "./host-thread";
import { buildHostReply } from "./reply";
import { sessionOfThread } from "./sessions";

type Event = Infer<typeof vHostEvent>;
type ImportOpen = Extract<Event, { kind: "import_open" }>;
type ImportTurn = Extract<Event, { kind: "import_turn" }>;

export type ImportResult =
    { ended: boolean; existing?: boolean; next: number; outcome: "applied"; threadId?: string } | { next: number; outcome: "gap" } | { outcome: "refused" };

const REFUSED: ImportResult = { outcome: "refused" };

const IMPORT_KINDS = new Set<string>(["import_end", "import_open", "import_turn"]);

export const isImportEvent = (event: Event): boolean => IMPORT_KINDS.has(event.kind);

/** The thread's title: what the agent called the session, else the agent and the folder, never a path. */
const importTitle = (open: ImportOpen): string => {
    const named = open.title?.trim() || `${open.agentLabel} · ${open.folderLabel}`;

    return named.slice(0, MAX_LENGTH.short);
};

/** `ended: true` = nothing more to send (done, or the session ran here); `next` = turns the backend holds. A session whose thread is gone is replaced. */
export const openImport = async (ctx: MutationCtx, device: Doc<"devices">, hostSessionId: string, events: Event[], now: number): Promise<ImportResult> => {
    const [open] = events;

    if (events.length !== 1 || open?.kind !== "import_open") {
        return REFUSED;
    }

    const found = await ctx.db.acpSessions.findFirst({
        where: { agentKey: open.agentKey, nativeSessionId: open.nativeSessionId, userId: device.userId },
    });

    // A hard-deleted thread leaves its session behind (the delete does not take it at once): that one is stale and is
    // dropped, and the import starts again. A soft-deleted thread can still be restored (undo), so its session stays
    // and the import is told it is over; it can be imported again once the thread is gone for good.
    const thread = found ? await ctx.db.threads.findFirst({ where: { _id: found.threadId } }) : null;

    if (found && !thread) {
        await ctx.db.delete(found._id);
    } else if (found) {
        if (thread?.deleted === true) {
            return { ended: true, existing: true, next: found.importedTurns ?? 0, outcome: "applied", threadId: found.threadId as string };
        }

        // An import begun on one of the user's computers can be finished from another: the hand-over is the open.
        if (found.importState === "importing" && found.deviceId !== device._id) {
            await ctx.db.patch(found._id, { deviceId: device._id, hostSessionId, updatedAt: now });
        }

        return {
            ended: found.importState !== "importing",
            existing: true,
            next: found.importedTurns ?? 0,
            outcome: "applied",
            threadId: found.threadId as string,
        };
    }

    const threadId = await insertThread(ctx.db, {
        createdBy: device.userId,
        mode: "text",
        model: open.agentKey,
        runner: "host",
        status: "active",
        tags: ["chat", "host"],
        title: importTitle(open),
        updatedAt: now,
        userId: device.userId,
    });

    await ctx.db.insert("acpSessions", {
        agentKey: open.agentKey,
        agentLabel: open.agentLabel,
        createdAt: now,
        deviceId: device._id,
        folderId: open.folderId,
        folderLabel: open.folderLabel,
        hostSessionId,
        importedTurns: 0,
        importState: "importing",
        lastEventAt: now,
        nativeSessionId: open.nativeSessionId,
        status: "ended",
        threadId,
        updatedAt: now,
        userId: device.userId,
        ...(open.capabilities && { capabilities: open.capabilities }),
    });

    return { ended: false, existing: false, next: 0, outcome: "applied", threadId: threadId as string };
};

/** One turn of the transcript: the prompt as a user message, the reply under it. Either may be empty, never both. */
const writeTurn = async (ctx: MutationCtx, session: Doc<"acpSessions">, threadId: Id<"threads">, turn: ImportTurn): Promise<void> => {
    let promptMessageId: Id<"messages"> | undefined;

    if (turn.user.trim() !== "") {
        const { messages } = await addMessagesHandler(ctx, {
            fromUser: true,
            messages: [{ message: { content: turn.user, role: "user" }, status: "success" }],
            threadId,
            userId: session.userId,
        });

        promptMessageId = messages[0]?._id as Id<"messages"> | undefined;
    }

    const reply = buildHostReply({
        agentKey: session.agentKey,
        reason: "finished",
        transcript: { children: [], media: [], reasoning: turn.reasoning ?? "", text: turn.text },
    });

    if (reply) {
        await addMessagesHandler(ctx, { messages: [reply], ...(promptMessageId && { promptMessageId }), threadId, userId: session.userId });
    }
};

export const applyImportTurns = async (
    ctx: MutationCtx,
    device: Doc<"devices">,
    args: { events: Event[]; firstSeq: number | undefined; hostSessionId: string; threadId: string },
    now: number,
): Promise<ImportResult> => {
    const { events, firstSeq } = args;
    const threadId = ctx.db.normalizeId("threads", args.threadId);
    const turnCount = events.filter((event) => event.kind === "import_turn").length;

    if (
        !threadId ||
        firstSeq === undefined ||
        !Number.isSafeInteger(firstSeq) ||
        firstSeq < 0 ||
        turnCount > MAX_IMPORT_TURNS_PER_POST ||
        events.some((event, index) => event.kind !== "import_turn" && !(event.kind === "import_end" && index === events.length - 1))
    ) {
        return REFUSED;
    }

    const thread = await ctx.db.threads.findFirst({ where: { _id: threadId } });
    const session = thread ? await sessionOfThread(ctx, threadId) : null;

    // The same owner comparisons a live turn gets: a verified device writes only into a host thread its own user
    // owns and that this device opened. A session that ran here (no `importState`) takes no import.
    if (
        !thread ||
        thread.deleted === true ||
        thread.userId !== device.userId ||
        !isHostRunThread(thread) ||
        session?.deviceId !== device._id ||
        session.hostSessionId !== args.hostSessionId ||
        session.importState === undefined
    ) {
        return REFUSED;
    }

    const held = session.importedTurns ?? 0;

    if (session.importState === "done") {
        return { ended: true, next: held, outcome: "applied" };
    }

    if (firstSeq > held) {
        return { next: held, outcome: "gap" };
    }

    // The end closes the post's turns, wherever the backend already stood: it is the last event or it is refused.
    const closes = events.at(-1)?.kind === "import_end";
    const unseen = events.slice(held - firstSeq).filter((event) => event.kind === "import_turn");

    // Refused before any turn is written: a refusal returns, it does not roll back what the loop already wrote.
    if (held + unseen.length > MAX_IMPORT_TURNS) {
        return REFUSED;
    }

    for (const event of unseen) {
        await writeTurn(ctx, session, threadId, event);
    }

    const count = held + unseen.length;

    await ctx.db.patch(session._id, { importedTurns: count, importState: closes ? "done" : "importing", lastEventAt: now, updatedAt: now });

    return { ended: closes, next: count, outcome: "applied" };
};
