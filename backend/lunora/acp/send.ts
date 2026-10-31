/**
 * `POST /hosts/send` — a message into a coding-agent thread from the web or the phone (plans/acp-agent-host.md
 * §4.6). The caller's bearer token names the owner; the body is `{ requestId, threadId, text }`.
 *
 * {@link sendToHost} stores everything in one mutation and returns before anything reaches the computer: the
 * prompt as the user's message, the stream the turn will write (`accepted`), and the signed `acp_send` call. If
 * the phone dies after its request, the rows exist and the computer still gets the call; on relaunch the phone
 * reads the stream's state and replays nothing. A retry of the same `requestId` finds the first try, not a second turn.
 *
 * Unlike a cloud turn there is no agent to schedule here: the computer runs it and posts its output to
 * `/hosts/ingest`. The reply is saved by the turn's end (`acp/lib/finish.ts`), not by a pending row written now.
 */
import type { HttpActionCtx } from "lunorash/server";
import { v } from "lunorash/server";

import { internal } from "../_generated/internal";
import { internalMutation } from "../_generated/server";
import { getCurrentUserInternal } from "../auth/lib/helper";
import { createStreamToken } from "../chat/streaming/persistent/stream-token";
import { claimedAtOf, claimOnce } from "../lib/claim-once";
import { checkRateLimit, getUserTier } from "../lib/rate-limiter";
import { MAX_LENGTH } from "../lib/validators";
import { isWorkerThread } from "../sub-agents/worker-thread";
import { readCappedBody } from "./http";
import { liveHostStream } from "./remote";
import { isHostRunThread } from "./lib/host-thread";
import { queueHostTurn } from "./lib/send-turn";
import { sessionOfThread } from "./lib/sessions";

/** How many of a thread's latest streams a retry looks through for its own; a turn is one stream, and a day holds few. */
const DUPLICATE_SCAN_STREAMS = 50;
const SEND_CLAIM_TTL_MS = 24 * 60 * 60 * 1000;
/** The prompt on the wire. The signed call carries it whole and caps its input at 32 KiB, which is what refuses a longer one. */
const MAX_SEND_CHARS = 30_000;
/** A prompt of that many characters is at most four bytes each; the rest of the body is three short fields. */
const MAX_SEND_BODY_BYTES = 130_000;

const vSendResult = v.union(
    v.object({ messageId: v.string(), outcome: v.literal("sent"), streamId: v.string() }),
    v.object({ messageId: v.optional(v.string()), outcome: v.literal("duplicate"), streamId: v.optional(v.string()) }),
    v.object({
        outcome: v.union(
            v.literal("busy"),
            v.literal("not_found"),
            v.literal("offline"),
            v.literal("rate_limited"),
            v.literal("session_ended"),
            v.literal("too_large"),
            v.literal("turn_running"),
            v.literal("worker_thread"),
        ),
    }),
);

export const sendToHost = internalMutation
    .input({
        // The caller's tier, as `/chat/start` takes it: the limit a paying account has is its own.
        plan: v.union(v.literal("free"), v.literal("premium")),
        requestId: v.string().max(MAX_LENGTH.id),
        text: v.string().max(100_000),
        threadId: v.string().max(MAX_LENGTH.id),
        userId: v.string().max(MAX_LENGTH.id),
    })
    .output(vSendResult)
    .mutation(async ({ args, ctx }) => {
        const { requestId, userId } = args;
        const { now } = ctx;
        const key = `${userId}:${requestId}`;
        const threadId = ctx.db.normalizeId("threads", args.threadId);
        const thread = threadId ? await ctx.db.threads.findFirst({ where: { _id: threadId } }) : null;

        // A host thread is the owner's alone: anyone else's, a cloud thread and a missing one read the same.
        if (!threadId || !thread || thread.userId !== userId || thread.deleted === true || !isHostRunThread(thread)) {
            return { outcome: "not_found" as const };
        }

        const claimedAt = await claimedAtOf(ctx, "host-send", key);

        if (claimedAt !== null) {
            // The claim is taken last, in the transaction that made the stream: the newest stream at or before it is
            // this request's, however many turns the thread has had since.
            const { page } = await ctx.db.persistentStreams.findMany({
                limit: DUPLICATE_SCAN_STREAMS,
                orderBy: [{ _creationTime: "desc" }],
                where: { producer: "host", threadId },
            });
            const first = page.find((stream) => stream._creationTime <= claimedAt);

            return { outcome: "duplicate" as const, ...(first && { messageId: first.messageId, streamId: first._id as string }) };
        }

        // A worker's thread takes a turn only through `dispatchToWorker`: a prompt sent here would run with no run behind it.
        if (await isWorkerThread(ctx, threadId)) {
            return { outcome: "worker_thread" as const };
        }

        const session = await sessionOfThread(ctx, threadId);

        if (!session || session.status === "ended") {
            return { outcome: "session_ended" as const };
        }

        // One turn at a time from here: a second prompt would queue on the computer behind a turn nobody can stop from the thread.
        if (await liveHostStream(ctx, threadId)) {
            return { outcome: "turn_running" as const };
        }

        const limited = await checkRateLimit(ctx, `hosts/send:${args.plan}`, { key: userId });

        if (!limited.ok) {
            return { outcome: "rate_limited" as const };
        }

        const queued = await queueHostTurn(ctx, { session, text: args.text, threadId, userId }, now);

        if ("error" in queued) {
            const outcomes = { busy: "busy", ineligible: "session_ended", input_too_large: "too_large", offline: "offline" } as const;

            return { outcome: outcomes[queued.error] };
        }

        await claimOnce(ctx, "host-send", key, SEND_CLAIM_TTL_MS, userId);

        return { messageId: queued.messageId, outcome: "sent" as const, streamId: queued.streamId as string };
    });

const json = (body: unknown, status: number): Response => Response.json(body, { status });

const STATUS: Record<string, number> = {
    busy: 429,
    not_found: 404,
    offline: 409,
    rate_limited: 429,
    session_ended: 409,
    too_large: 413,
    turn_running: 409,
    worker_thread: 409,
};

export const hostSendHttpAction = async (context: HttpActionCtx, request: Request): Promise<Response> => {
    const signingSecret = process.env.LLM_GATEWAY_SIGNING_SECRET;

    if (!signingSecret) {
        return json({ error: "not_configured" }, 500);
    }

    // Capped before it is parsed: the prompt limit is characters, the body a few times that in bytes.
    const raw = await readCappedBody(request, MAX_SEND_BODY_BYTES);

    if (raw === null) {
        return json({ error: "too_large" }, 413);
    }

    let body: unknown;

    try {
        body = JSON.parse(raw);
    } catch {
        return json({ error: "malformed" }, 400);
    }

    const { requestId, text, threadId } = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;

    if (
        typeof requestId !== "string" ||
        typeof threadId !== "string" ||
        typeof text !== "string" ||
        requestId.length === 0 ||
        requestId.length > MAX_LENGTH.id ||
        threadId.length > MAX_LENGTH.id ||
        text.trim() === "" ||
        text.length > MAX_SEND_CHARS
    ) {
        return json({ error: "malformed" }, 400);
    }

    let user: Awaited<ReturnType<typeof getCurrentUserInternal>>;

    try {
        user = await getCurrentUserInternal(context);
    } catch {
        return json({ error: "not_authenticated" }, 401);
    }

    const userId = user?._id;

    if (!userId) {
        return json({ error: "not_authenticated" }, 401);
    }

    const plan = getUserTier({ plan: user?.plan ?? null }) === "premium" ? "premium" : "free";

    const result = await context.runMutation(internal.acp.send.sendToHost, { plan, requestId, text, threadId, userId });

    if (result.outcome === "sent") {
        const streamToken = await createStreamToken(result.streamId, userId, threadId, signingSecret);

        return json({ messageId: result.messageId, streamId: result.streamId, streamToken }, 200);
    }

    if (result.outcome === "duplicate") {
        return json(
            {
                duplicate: true,
                ...(result.messageId !== undefined && { messageId: result.messageId }),
                ...(result.streamId !== undefined && {
                    streamId: result.streamId,
                    streamToken: await createStreamToken(result.streamId, userId, threadId, signingSecret),
                }),
            },
            200,
        );
    }

    return json({ error: result.outcome }, STATUS[result.outcome] ?? 400);
};
