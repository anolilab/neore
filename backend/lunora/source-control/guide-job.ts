/**
 * The cloud guide job, on the jobs queue: read the pull request with the user's own token, ask the utility model
 * through the gateway, assemble, save. `runJobOnce` claims the job before it runs, so a redelivery never reaches the
 * paid model call a second time; a delivery that dies mid-run is failed by `failAbandonedGuide`.
 *
 * Every outcome lands on the guide row (`ready` or `failed` with a code). Nothing here can write to the host: the reads
 * come through `GuideReads` and the model's answer only becomes a proposal.
 */
import { generateObject } from "ai";
import z from "zod/v4";

import { internal } from "../_generated/internal";
import { internalAction } from "../_generated/server";
import { resolveGithubToken } from "../connectors/lib/github-token";
import { gatewayFetch } from "../lib/services";
import { getUtilityModel } from "../lib/utility-model";
import { MAX_LENGTH } from "../lib/validators";
import { v } from "lunorash/server";
import { DEVELOP_DRIVER } from "./develop-driver";
import { buildGuide, readPullRequestForGuide } from "./guide-generate";
import type { AskModel } from "./guide-generate";
import { readFromHost } from "./read-host";

/** A guide over a large diff takes a while; a hung gateway must not hold the job for ever. */
const GUIDE_TIMEOUT_MS = 180_000;

const GUIDE_MAX_OUTPUT_TOKENS = 12_000;

/**
 * Loose on purpose: the structure is `assembleGuide`'s to decide, so a model that gets a role or a kind wrong still
 * answers, and the odd part is dropped rather than failing the whole guide.
 */
export const guideOutputSchema = z.object({
    proposals: z
        .array(
            z.object({
                body: z.string().optional(),
                kind: z.string(),
                line: z.number().optional(),
                name: z.string().optional(),
                path: z.string().optional(),
                reason: z.string().optional(),
                side: z.string().optional(),
                startLine: z.number().nullish(),
            }),
        )
        .optional(),
    stops: z.array(
        z.object({
            explanation: z.string(),
            files: z.array(z.object({ path: z.string(), ranges: z.array(z.object({ end: z.number(), side: z.string(), start: z.number() })).optional() })),
            role: z.string(),
            title: z.string(),
        }),
    ),
    summary: z.string(),
});

export const runCloudGuide = internalAction
    .input({
        guideId: v.id("pullRequestGuides"),
        /** Set by `runJobOnce`: the claim key. */
        jobId: v.optional(v.string().max(MAX_LENGTH.id)),
        userId: v.string().max(MAX_LENGTH.id),
    })
    .output(v.null())
    .action(async ({ args, ctx }) => {
        const { guideId, userId } = args;
        const row = await ctx.runQuery(internal.source_control.guide_internal.readGuideForJob, { guideId, userId });

        if (!row) {
            return null;
        }

        const fail = async (failure: "host_error" | "model_error" | "not_connected" | "too_large"): Promise<null> => {
            await ctx.runMutation(internal.source_control.guide_internal.failGuide, { failure, guideId, userId });

            return null;
        };
        const token = await resolveGithubToken(ctx, userId);
        const read = await readFromHost(
            DEVELOP_DRIVER,
            token,
            async (request) => await readPullRequestForGuide(DEVELOP_DRIVER, request, { number: row.number, repository: row.repository }),
        );

        if (read.status !== "ok") {
            return await fail(read.status === "not_connected" || read.status === "needs_reconnect" ? "not_connected" : "host_error");
        }

        const ask: AskModel = async ({ prompt, system }) => {
            const { object } = await generateObject({
                abortSignal: AbortSignal.timeout(GUIDE_TIMEOUT_MS),
                maxOutputTokens: GUIDE_MAX_OUTPUT_TOKENS,
                model: await getUtilityModel(gatewayFetch(ctx), { userId }),
                prompt,
                schema: guideOutputSchema,
                system,
                temperature: 0.2,
            });

            return object;
        };

        try {
            const guide = await buildGuide(read, row.instructions, ask);
            const saved = await ctx.runMutation(internal.source_control.guide_internal.saveGuide, {
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
                saved,
                source: "cloud",
                stops: guide.stops.length,
            });
        } catch (error) {
            ctx.log.event("source_control.guide_failed", { message: error instanceof Error ? error.message : "unknown", source: "cloud" });

            return await fail("model_error");
        }

        return null;
    });
