/**
 * Host turn output, server side (plans/acp-agent-host.md §4.2–4.3): the internal functions behind
 * `POST /hosts/ingest` (`acp/http.ts`).
 *
 * - {@link verifyHostPost}: a query on the owner's shard that loads the device, checks the `turn` signature and
 *   freshness, and returns the owner. The action never sees the secret.
 * - {@link applyHostEvents}: ONE mutation per post. The rate limit comes first, then the owner comparisons (an
 *   internal mutation runs without RLS, so nothing else stands between a verified device and a thread), then the
 *   claim by `(turnId, seq)`: events at or before the last stored `seq` are dropped, a post that starts past
 *   the next free `seq` answers `gap`, and the rest are written.
 *
 * `lastSeq` is never a counter on the stream row (a write per post would re-run `getActiveStreamForThread` for
 * every viewer); it is the last chunk of `by_streamId_seq`, so every event, tool and permission events and the
 * end of the turn included, writes a chunk.
 */
import type { Infer } from "lunorash/server";
import { v } from "lunorash/server";

import type { Doc } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { internalMutation, internalQuery } from "../_generated/server";
import { addMessagesHandler } from "../agent/messages";
import { insertThread } from "../agent/table-writes";
import {
    appendHostChunk,
    bumpedExpiry,
    createHostStream,
    isForwardHostState,
    isLiveStream,
    nextHostSeq,
    updateHostStream,
} from "../chat/streaming/persistent/host";
import { noteShardDue } from "../lib/shard-housekeeping";
import { decryptKey } from "../lib/encryption";
import { checkRateLimit } from "../lib/rate-limiter";
import { MAX_LENGTH } from "../lib/validators";
import { DEVICE_SIGNATURE_WINDOW_MS } from "../devices/lib/constants";
import { isFreshTimestamp, parseSignedPayload, verifyDevicePayload } from "../devices/lib/signing";
import { MAX_EVENTS_PER_POST } from "./lib/constants";
import { finishHostTurn } from "./lib/finish";
import { isHostRunThread } from "./lib/host-thread";
import { reapExpiredHostStreams } from "./lib/reap";
import { sessionOfThread, touchSession } from "./lib/sessions";
import { vHostEvent } from "./validators";

type Event = Infer<typeof vHostEvent>;

/** Who owns the device whose signed post this is, or null: unknown or revoked device, bad signature, stale post. */
export const verifyHostPost = internalQuery
    .input({ deviceId: v.string().max(MAX_LENGTH.id), now: v.number(), payload: v.string().max(MAX_LENGTH.document), signature: v.string().max(128) })
    .output(v.union(v.null(), v.object({ userId: v.string() })))
    .query(async ({ args, ctx }) => {
        const deviceId = ctx.db.normalizeId("devices", args.deviceId);
        const device = deviceId ? await ctx.db.devices.findFirst({ where: { _id: deviceId } }) : null;

        if (!device?.encryptedSecret) {
            return null;
        }

        const secret = await decryptKey(device.encryptedSecret, "device-secrets");

        if (!(await verifyDevicePayload(secret, "turn", args.payload, args.signature))) {
            return null;
        }

        const post = parseSignedPayload(args.payload, "turn", device._id as string);

        return post && isFreshTimestamp(post.issuedAt, args.now, DEVICE_SIGNATURE_WINDOW_MS) ? { userId: device.userId } : null;
    });

const vApplyResult = v.union(
    v.object({ ended: v.boolean(), next: v.number(), outcome: v.literal("applied"), threadId: v.optional(v.string()) }),
    v.object({ next: v.number(), outcome: v.literal("gap") }),
    v.object({ outcome: v.literal("refused") }),
    v.object({ outcome: v.literal("limited") }),
);

type ApplyResult = Infer<typeof vApplyResult>;

const REFUSED: ApplyResult = { outcome: "refused" };

/** A host thread's title: the agent and the folder, never a path. */
const sessionTitle = (event: Extract<Event, { kind: "session_open" }>): string => `${event.agentLabel} · ${event.folderLabel}`.slice(0, MAX_LENGTH.short);

/**
 * `session_open`: creates the host thread and its session, or finds them again. The desktop's own session id
 * (`hostSessionId`, indexed with the device) makes a redelivered open the same session, not a second thread.
 */
const openSession = async (ctx: MutationCtx, device: Doc<"devices">, hostSessionId: string, events: Event[], now: number): Promise<ApplyResult> => {
    const [open] = events;

    if (events.length !== 1 || open?.kind !== "session_open") {
        return REFUSED;
    }

    const existing = await ctx.db.acpSessions.findFirst({ where: { deviceId: device._id, hostSessionId } });

    if (existing) {
        // The agent can report more once it has been used; the thread and session stay as they are.
        if (open.capabilities && existing.status !== "ended") {
            await ctx.db.patch(existing._id, { capabilities: open.capabilities, updatedAt: now });
        }

        return { ended: existing.status === "ended", next: 0, outcome: "applied", threadId: existing.threadId as string };
    }

    const threadId = await insertThread(ctx.db, {
        createdBy: device.userId,
        mode: "text",
        model: open.agentKey,
        runner: "host",
        status: "active",
        tags: ["chat", "host"],
        title: sessionTitle(open),
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
        lastEventAt: now,
        status: "idle",
        threadId,
        updatedAt: now,
        userId: device.userId,
        ...(open.capabilities && { capabilities: open.capabilities }),
        ...(open.nativeSessionId !== undefined && { nativeSessionId: open.nativeSessionId }),
    });

    return { ended: false, next: 0, outcome: "applied", threadId: threadId as string };
};

/** Events that come from the agent itself: the first of them moves a turn to `running`. */
const isAgentEvent = (event: Event): boolean => event.kind !== "turn_start" && event.kind !== "turn_end" && event.kind !== "session_open";

/** The chunk an event leaves. Text and reasoning are the chunk's own fields; anything else rides as `event`. */
const chunkFor = (event: Event): Pick<Doc<"persistentChunks">, "event" | "reasoning" | "text"> => {
    if (event.kind === "text") {
        return { text: event.text };
    }

    if (event.kind === "reasoning") {
        return { reasoning: event.text, text: "" };
    }

    // The prompt is the user's saved message; the chunk only claims the slot.
    return { event: event.kind === "turn_start" ? { kind: "turn_start", text: "" } : event, text: "" };
};

const pendingAfter = (pending: string[], event: Event): string[] => {
    if (event.kind === "permission_request") {
        return pending.includes(event.requestId) ? pending : [...pending, event.requestId];
    }

    if (event.kind === "permission_resolved") {
        return pending.filter((id) => id !== event.requestId);
    }

    return pending;
};

const applyTurnPost = async (
    ctx: MutationCtx,
    device: Doc<"devices">,
    args: { events: Event[]; firstSeq: number | undefined; hostSessionId: string; threadId: string; turnId: string | undefined },
    now: number,
): Promise<ApplyResult> => {
    const { events, firstSeq, turnId } = args;
    const threadId = ctx.db.normalizeId("threads", args.threadId);

    if (
        !threadId ||
        !turnId ||
        firstSeq === undefined ||
        !Number.isSafeInteger(firstSeq) ||
        firstSeq < 0 ||
        events.some((event) => event.kind === "session_open")
    ) {
        return REFUSED;
    }

    // The owner comparisons. A verified device may write only into a host thread its own user owns and runs a
    // session in; shard isolation proves none of this, so each is checked here.
    const thread = await ctx.db.threads.findFirst({ where: { _id: threadId } });
    const session = thread ? await sessionOfThread(ctx, threadId) : null;

    if (
        !thread ||
        thread.deleted === true ||
        thread.userId !== device.userId ||
        !isHostRunThread(thread) ||
        session?.deviceId !== device._id ||
        session.hostSessionId !== args.hostSessionId ||
        session.status === "ended"
    ) {
        return REFUSED;
    }

    let stream = await ctx.db.persistentStreams.findFirst({ where: { hostTurnId: turnId } });

    if (stream && (stream.userId !== device.userId || stream.threadId !== (threadId as string))) {
        return REFUSED;
    }

    if (!stream) {
        const [first] = events;

        // A turn the backend did not queue begins with the user's prompt, as the host's first event.
        if (first?.kind !== "turn_start" || firstSeq !== 0) {
            return REFUSED;
        }

        const { messages } = await addMessagesHandler(ctx, {
            fromUser: true,
            messages: [{ message: { content: first.text, role: "user" }, status: "success" }],
            threadId,
            userId: device.userId,
        });
        const prompt = messages[0];

        if (!prompt) {
            return REFUSED;
        }

        const streamId = await createHostStream(ctx, { hostState: "received", messageId: prompt._id, threadId, turnId, userId: device.userId }, now);

        stream = await ctx.db.persistentStreams.findFirst({ where: { _id: streamId } });
    }

    if (!stream) {
        return REFUSED;
    }

    const next = await nextHostSeq(ctx, stream._id);

    // A stream that is over takes nothing more (the reaper timed it out, Stop ended it, a revoke cut it). The
    // host reads `ended` and stops posting.
    if (!isLiveStream(stream)) {
        return { ended: true, next, outcome: "applied" };
    }

    if (firstSeq > next) {
        return { next, outcome: "gap" };
    }

    const fresh = events.slice(next - firstSeq);
    let pending = stream.hostPendingPermissions ?? [];
    let { hostState } = stream;
    let seq = next;
    let sawContent = false;
    let ended = false;

    for (const event of fresh) {
        await appendHostChunk(ctx, stream._id, seq, chunkFor(event));
        seq += 1;
        pending = pendingAfter(pending, event);

        if (event.kind === "turn_start" && isForwardHostState(hostState, "received")) {
            hostState = "received";
        }

        if (isAgentEvent(event)) {
            sawContent = true;

            if (isForwardHostState(hostState, "running")) {
                hostState = "running";
            }
        }

        if (event.kind === "turn_end") {
            ended = true;
            break;
        }
    }

    const live = { ...stream, hostState };

    if (ended) {
        const end = fresh.find((event) => event.kind === "turn_end");

        if (end?.kind === "turn_end") {
            await finishHostTurn(ctx, live, { error: end.error, reason: end.reason }, now);
        }

        return { ended: true, next: seq, outcome: "applied" };
    }

    const expiresAt = bumpedExpiry(stream, now);
    const pendingChanged = pending.join("\n") !== (stream.hostPendingPermissions ?? []).join("\n");
    const stateChanged = hostState !== stream.hostState;
    const startsStreaming = sawContent && stream.status === "pending";

    // The stream row is read by a live query, so a plain text post (none of these) writes nothing to it.
    if (stateChanged || startsStreaming || expiresAt !== undefined || pendingChanged) {
        await updateHostStream(ctx, stream, {
            expiresAt,
            hostState: stateChanged ? hostState : undefined,
            pending: pendingChanged ? pending : undefined,
            streaming: startsStreaming,
        });

        if (expiresAt !== undefined) {
            await noteShardDue(ctx, expiresAt);
        }
    }

    await touchSession(ctx, session, "busy", now);

    return { ended: false, next: seq, outcome: "applied" };
};

/**
 * One verified post. `threadId` absent = a session-level post (`session_open`); present = a turn post.
 * `limited` and `refused` change nothing.
 */
export const applyHostEvents = internalMutation
    .input({
        deviceId: v.string().max(MAX_LENGTH.id),
        events: v.array(vHostEvent).check((events) => events.length <= MAX_EVENTS_PER_POST, { message: "Too many events" }),
        firstSeq: v.optional(v.number()),
        sessionId: v.string().max(MAX_LENGTH.id),
        threadId: v.optional(v.string().max(MAX_LENGTH.id)),
        turnId: v.optional(v.string().max(MAX_LENGTH.id)),
    })
    .output(vApplyResult)
    .mutation(async ({ args, ctx }) => {
        // Keyed by the VERIFIED device, so a forged post cannot spend a victim's budget.
        const limited = await checkRateLimit(ctx, "hosts/ingest:free", { key: args.deviceId });

        if (!limited.ok) {
            return { outcome: "limited" as const };
        }

        const deviceId = ctx.db.normalizeId("devices", args.deviceId);
        const device = deviceId ? await ctx.db.devices.findFirst({ where: { _id: deviceId } }) : null;

        if (!device?.encryptedSecret) {
            return REFUSED;
        }

        const { now } = ctx;

        if (args.threadId === undefined) {
            return await openSession(ctx, device, args.sessionId, args.events, now);
        }

        return await applyTurnPost(
            ctx,
            device,
            { events: args.events, firstSeq: args.firstSeq, hostSessionId: args.sessionId, threadId: args.threadId, turnId: args.turnId },
            now,
        );
    });

/** The shard tick (`lib/shard-housekeeping.ts#runShardTick`): reap silent host streams, then re-arm for the next. */
export const reapHostStreams = internalMutation
    .input({})
    .output(v.null())
    .mutation(async ({ ctx }) => {
        const next = await reapExpiredHostStreams(ctx, ctx.now);

        if (next !== undefined) {
            await noteShardDue(ctx, next);
        }

        return null;
    });
