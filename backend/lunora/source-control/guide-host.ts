/**
 * Writing a guide with a coding agent on one of the user's own computers, in a local checkout of the repository.
 *
 * - `startHostGuide` (action) reads the pull request from the host, builds the prompt and hands it to
 *   `beginHostGuide` (mutation), which reserves the guide row, starts a host session for the approved (agent, folder)
 *   pair and sends the prompt, all in ONE transaction: if the computer cannot take the call, nothing is left behind.
 * - The turn then runs like any host turn. When it ends, `guide-host-end.ts#settleHostGuide` fails the guide or queues
 *   `finalizeHostGuide`, which reads the agent's answer, checks it against the diff exactly as the cloud path does
 *   (`assembleGuide`) and saves it.
 *
 * Host turns write no usage row and charge no credit, so unlike the cloud path nothing is charged here.
 */
import type { Infer } from "lunorash/server";
import { LunoraError, v } from "lunorash/server";

import { internal } from "../_generated/internal";
import { internalAction, internalMutation, internalQuery } from "../_generated/server";
import { readHostTranscript } from "../acp/lib/finish";
import { startHostSessionFor } from "../acp/remote";
import { sendToHostFor } from "../acp/send";
import { authAction, rateLimit } from "../lib/crpc";
import { resolveGithubToken } from "../connectors/lib/github-token";
import { isDeviceOnline } from "../devices/lib/state";
import type { DeviceTaintSource } from "../devices/lib/taint";
import { getUserTier } from "../lib/rate-limiter";
import { MAX_LENGTH } from "../lib/validators";
import { DEVELOP_DRIVER } from "./develop-driver";
import { guideFromHostAnswer, promptInputOf, readPullRequestForGuide } from "./guide-generate";
import { reserveGuide } from "./guide-internal";
import { extractJsonObject, folderMatchesRepo } from "./guide-logic";
import { buildHostGuidePrompt, HOST_PROMPT_MAX_BYTES, hostPromptBytes } from "./guide-prompt";
import { readFromHost } from "./read-host";
import { vFailed } from "./validators";

const HOST_ROLLBACK = "guide_host:";

/** What a guide prompt reads: text other people wrote on the host. */
const GUIDE_TAINT: ReadonlyArray<DeviceTaintSource> = ["web"];

/** The refusals of a send that the page words for itself; any other is a "busy" in effect. */
const REPORTED_OUTCOMES: ReadonlySet<string> = new Set(["busy", "offline", "rate_limited", "session_ended", "too_large"]);

const vUnavailable = v.object({
    reason: v.union(v.literal("busy"), v.literal("offline"), v.literal("rate_limited"), v.literal("session_ended"), v.literal("too_large")),
    status: v.literal("unavailable"),
});

/**
 * Reserves the guide, starts the session and sends the prompt. A refusal after the first write THROWS, so the guide
 * row, the thread, the session and the claim are rolled back together rather than left as a guide that spins.
 */
export const beginHostGuide = internalMutation
    .input({
        agentKey: v.string().max(MAX_LENGTH.id),
        deviceId: v.id("devices"),
        folderId: v.string().max(MAX_LENGTH.id),
        headSha: v.string().max(MAX_LENGTH.short),
        instructions: v.string().max(MAX_LENGTH.long),
        number: v.number(),
        plan: v.union(v.literal("free"), v.literal("premium")),
        repository: v.string().max(MAX_LENGTH.short),
        text: v.string().max(MAX_LENGTH.document),
        userId: v.string().max(MAX_LENGTH.id),
    })
    .output(
        v.union(
            v.object({ status: v.literal("started"), threadId: v.string() }),
            v.object({ status: v.union(v.literal("folder_mismatch"), v.literal("running")) }),
            vUnavailable,
        ),
    )
    .mutation(async ({ args, ctx }) => {
        const { userId } = args;
        const device = await ctx.db.devices.findFirst({ where: { _id: args.deviceId, userId } });
        const offer = device?.acpOffers?.find((candidate) => candidate.agentKey === args.agentKey && candidate.folderId === args.folderId);

        // A folder is offered by its label, which is the user's own text: it must at least look like this repository.
        if (!device || !offer || !folderMatchesRepo(offer.folderLabel, args.repository)) {
            return { status: "folder_mismatch" as const };
        }

        if (!isDeviceOnline(device, ctx.now)) {
            return { reason: "offline" as const, status: "unavailable" as const };
        }

        const reserved = await reserveGuide(ctx, {
            headSha: args.headSha,
            instructions: args.instructions,
            number: args.number,
            repository: args.repository,
            source: "host",
            userId,
        });

        if (reserved.status === "running") {
            return { status: "running" as const };
        }

        // The session start refuses only when the computer is busy or went offline between the check above and now.
        const started = await startHostSessionFor(ctx, userId, {
            agentKey: args.agentKey,
            clientId: crypto.randomUUID(),
            deviceId: args.deviceId,
            folderId: args.folderId,
        }).catch(() => {
            throw new LunoraError("BAD_REQUEST", `${HOST_ROLLBACK}busy`);
        });

        if (!started.started || started.threadId === undefined) {
            throw new LunoraError("INTERNAL", "The guide's session did not start");
        }

        // The prompt carries a pull request's title, body and paths: third-party text, so the turn is signed as tainted.
        const sent = await sendToHostFor(ctx, {
            plan: args.plan,
            requestId: crypto.randomUUID(),
            taintedBy: GUIDE_TAINT,
            text: args.text,
            threadId: started.threadId,
            userId,
        });

        if (sent.outcome !== "sent") {
            // A brand-new thread has no turn running and is its owner's: the outcomes below that are not on the user's list are a "busy" in effect.
            const reason = REPORTED_OUTCOMES.has(sent.outcome) ? (sent.outcome as Unavailable["reason"]) : "busy";

            throw new LunoraError("BAD_REQUEST", `${HOST_ROLLBACK}${reason}`);
        }

        await ctx.db.patch(reserved.guideId, { threadId: started.threadId });

        ctx.log.event("source_control.guide_requested", { source: "host" });

        return { status: "started" as const, threadId: started.threadId };
    });

type Unavailable = Infer<typeof vUnavailable>;

const unavailableReason = (error: unknown): Unavailable["reason"] | null => {
    const message = error instanceof Error ? error.message : "";
    const reason = message.startsWith(HOST_ROLLBACK) ? message.slice(HOST_ROLLBACK.length) : null;

    switch (reason) {
        case "busy":
        case "offline":
        case "rate_limited":
        case "session_ended":
        case "too_large": {
            return reason;
        }
        default: {
            return null;
        }
    }
};

/**
 * Asks the user's coding agent, on the computer they chose, to write the guide. The head commit comes from the host
 * here, never from the page; the agent reads the change with read-only git and answers with the same JSON the cloud
 * model does, which is checked the same way before anything is kept.
 */
export const startHostGuide = authAction
    .use(rateLimit("sourceControl/guide"))
    .input({
        agentKey: v.string().max(MAX_LENGTH.id),
        deviceId: v.id("devices"),
        folderId: v.string().max(MAX_LENGTH.id),
        instructions: v.string().max(MAX_LENGTH.long),
        number: v.number(),
        repository: v.string().max(MAX_LENGTH.short),
    })
    .output(
        v.union(
            v.object({ status: v.literal("started"), threadId: v.string() }),
            v.object({ status: v.union(v.literal("folder_mismatch"), v.literal("guest"), v.literal("running"), v.literal("too_large")) }),
            vUnavailable,
            vFailed,
        ),
    )
    .action(async ({ args, ctx }) => {
        const { plan, userId } = ctx.user;
        const flags = await ctx.runQuery(internal.auth.functions.getUserAuthFlagsQuery, { userId });

        if (flags.isAnonymous) {
            return { status: "guest" as const };
        }

        const token = await resolveGithubToken(ctx, userId);
        const read = await readFromHost(
            DEVELOP_DRIVER,
            token,
            async (request) => await readPullRequestForGuide(DEVELOP_DRIVER, request, { number: args.number, repository: args.repository }),
        );

        if (read.status !== "ok") {
            return { status: read.status };
        }

        const instructions = args.instructions.trim();
        const text = buildHostGuidePrompt(promptInputOf(read, instructions));

        // The reviewer's own instructions are the one part that is not trimmed to fit.
        if (hostPromptBytes(text) > HOST_PROMPT_MAX_BYTES) {
            return { status: "too_large" as const };
        }

        try {
            return await ctx.runMutation(internal.source_control.guide_host.beginHostGuide, {
                agentKey: args.agentKey,
                deviceId: args.deviceId,
                folderId: args.folderId,
                headSha: read.headSha,
                instructions,
                number: args.number,
                plan: getUserTier({ plan: plan ?? null }) === "premium" ? "premium" : "free",
                repository: args.repository,
                text,
                userId,
            });
        } catch (error) {
            const reason = unavailableReason(error);

            if (reason === null) {
                throw error;
            }

            return { reason, status: "unavailable" as const };
        }
    });

/** The agent's answer and what it was asked, for the finalizer. `null` when the guide is gone, is not waiting for this turn, or the turn is not its own. */
export const readHostGuideAnswer = internalQuery
    .input({ guideId: v.id("pullRequestGuides"), streamId: v.id("persistentStreams"), userId: v.string().max(MAX_LENGTH.id) })
    .output(v.union(v.null(), v.object({ answer: v.union(v.string(), v.null()), headSha: v.string(), number: v.number(), repository: v.string() })))
    .query(async ({ args, ctx }) => {
        const guide = await ctx.db.pullRequestGuides.findFirst({ where: { _id: args.guideId, userId: args.userId } });
        const stream = await ctx.db.persistentStreams.findFirst({ where: { _id: args.streamId, userId: args.userId } });

        if (!guide || guide.status !== "generating" || !stream || guide.threadId === undefined || guide.threadId !== stream.threadId) {
            return null;
        }

        const { text } = await readHostTranscript(ctx, stream._id);
        const answer = extractJsonObject(text);

        return { answer: answer === null ? null : JSON.stringify(answer), headSha: guide.headSha, number: guide.number, repository: guide.repository };
    });

/**
 * Turns a finished host turn into a guide. Idempotent: `saveGuide` and `failGuide` only take a row still `generating`,
 * so a redelivery changes nothing. The agent's line numbers are checked against the diff the host shows NOW, so a pull
 * request that moved since the agent read it fails the guide (`head_moved`) rather than checking one diff against another.
 */
export const finalizeHostGuide = internalAction
    .input({ guideId: v.id("pullRequestGuides"), streamId: v.id("persistentStreams"), userId: v.string().max(MAX_LENGTH.id) })
    .output(v.null())
    .action(async ({ args, ctx }) => {
        const { guideId, userId } = args;
        const row = await ctx.runQuery(internal.source_control.guide_host.readHostGuideAnswer, args);

        if (!row) {
            return null;
        }

        const fail = async (failure: "head_moved" | "host_error" | "no_answer" | "not_connected"): Promise<null> => {
            await ctx.runMutation(internal.source_control.guide_internal.failGuide, { failure, guideId, userId });

            return null;
        };

        // An answer that is not there needs no host read to be refused.
        if (row.answer === null) {
            return await fail("no_answer");
        }

        const token = await resolveGithubToken(ctx, userId);
        const read = await readFromHost(
            DEVELOP_DRIVER,
            token,
            async (request) => await readPullRequestForGuide(DEVELOP_DRIVER, request, { number: row.number, repository: row.repository }),
        );

        if (read.status !== "ok") {
            return await fail(read.status === "not_connected" || read.status === "needs_reconnect" ? "not_connected" : "host_error");
        }

        const checked = guideFromHostAnswer(read, row.headSha, row.answer);

        if ("failure" in checked) {
            return await fail(checked.failure);
        }

        const { guide } = checked;

        await ctx.runMutation(internal.source_control.guide_internal.saveGuide, {
            guideId,
            headSha: read.headSha,
            leftOut: guide.leftOut,
            proposals: guide.proposals,
            stops: guide.stops,
            summary: guide.summary,
            userId,
        });
        ctx.log.event("source_control.guide_generated", {
            files: read.files.length,
            proposals: guide.proposals.length,
            source: "host",
            stops: guide.stops.length,
        });

        return null;
    });
