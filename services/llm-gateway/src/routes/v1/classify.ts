/**
 * POST /v1/classify — Prompt classification without LLM invocation.
 * POST /v1/classify/batch — Batch prompt classification.
 *
 * Exposes the gateway's 23-dimension query scorer as a standalone API.
 * Useful for debugging routing decisions, client-side pre-classification,
 * and testing new routing rules — without consuming LLM tokens.
 *
 * Auth: HMAC (internal) or Bearer token (SaaS).
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import type { ModelMessage } from "ai";
import { createMiddleware } from "hono/factory";
import { z } from "zod";

import type { HonoEnv } from "../../env.js";
import { bearerAuth, internalAuth } from "../../middleware/auth.js";
import { expensiveEndpointRateLimit } from "../../middleware/rate-limit.js";
import { GATEWAY_MODELS } from "../../models.js";
import { scoreQuery } from "../../routing/scorer.js";
import type { RoutingProfile } from "../../routing/tiers.js";
import { applyRoutingProfile, classifyTier, TIER_MODEL_POOLS } from "../../routing/tiers.js";

const classifyRouter = new OpenAPIHono<HonoEnv>();

/** Accept HMAC (internal/backend) or Bearer token (SaaS API users) */
const classifyAuth = createMiddleware<HonoEnv>(async (c, next) => {
    const authHeader = c.req.header("Authorization");

    if (authHeader?.startsWith("Bearer ")) {
        return bearerAuth(c, next);
    }

    return internalAuth(c, next);
});

/**
 * Apply rate limit only when the request authenticated via bearer token
 * (SaaS API path). Internal HMAC calls don't carry a userId and are
 * already trust-gated by the shared signing secret.
 */
const classifyRateLimit = (bucket: string, multiplier?: number) => {
    const inner = expensiveEndpointRateLimit({ bucket, tierMultiplier: multiplier });

    return createMiddleware<HonoEnv>(async (c, next) => {
        if (c.get("userId")) {
            return inner(c, next);
        }

        return next();
    });
};

/** Cap classification inputs so callers can't burn CPU with mega-payloads. */
const MAX_MESSAGES_PER_REQUEST = 200;
const MAX_TOOLS_PER_REQUEST = 100;

const classifyRequestSchema = z.object({
    messages: z.array(z.record(z.string(), z.unknown())).min(1).max(MAX_MESSAGES_PER_REQUEST),
    preferredQuality: z.number().min(0).max(1).optional(),
    routingProfile: z.enum(["auto", "eco", "free", "fast", "premium", "reasoning"]).optional().default("auto"),
    systemPrompt: z.string().max(50_000).optional(),
    tools: z
        .record(z.string(), z.unknown())
        .refine((tools) => Object.keys(tools).length <= MAX_TOOLS_PER_REQUEST, {
            error: `tools must contain at most ${MAX_TOOLS_PER_REQUEST} entries`,
        })
        .optional(),
    userTier: z.string().max(64).optional().default("free"),
});

const classifyResponseSchema = z.object({
    effectiveTier: z.string(),
    profile: z.string(),
    reasoning: z.string(),
    recommendedModel: z.string(),
    score: z.object({
        codeGeneration: z.number(),
        combined: z.number(),
        complexity: z.number(),
        contextLength: z.number(),
        creativity: z.number(),
        language: z.string(),
        multimodal: z.number(),
        reasoning: z.number(),
        technicalDomain: z.number(),
        toolUse: z.number(),
    }),
    tier: z.string(),
});

type ClassifyResponse = z.infer<typeof classifyResponseSchema>;

const computeClassification = (
    messages: ModelMessage[],
    toolCount: number,
    userTier: string,
    preferredQuality: number | undefined,
    profile: RoutingProfile,
): ClassifyResponse => {
    const score = scoreQuery({
        messages,
        preferredQuality,
        toolCount,
        userTier,
    });

    const scoredTier = classifyTier(score.combined);
    const effectiveTier = applyRoutingProfile(scoredTier, profile);
    const modelPool = TIER_MODEL_POOLS[effectiveTier];
    const recommendedModel = GATEWAY_MODELS.find((m) => m.modelId === modelPool[0])?.modelId ?? modelPool[0] ?? "gpt-4o";

    const profileNote = profile === "auto" ? "" : ` Profile '${profile}' overrode scored tier '${scoredTier}'.`;
    const reasoning = `Query scored ${score.combined.toFixed(3)} → classified as '${scoredTier}' tier.${
        profileNote
    } Effective tier: '${effectiveTier}'. Recommended model: ${recommendedModel}.`;

    return {
        effectiveTier,
        profile,
        reasoning,
        recommendedModel,
        score: {
            codeGeneration: score.codeGeneration,
            combined: score.combined,
            complexity: score.complexity,
            contextLength: score.contextLength,
            creativity: score.creativity,
            language: score.language,
            multimodal: score.multimodal,
            reasoning: score.reasoning,
            technicalDomain: score.technicalDomain,
            toolUse: score.toolUse,
        },
        tier: scoredTier,
    };
};

// POST /v1/classify — single prompt classification
classifyRouter.openapi(
    {
        method: "post",
        middleware: [classifyAuth, classifyRateLimit("classify")] as const,
        path: "/v1/classify",
        request: {
            body: {
                content: { "application/json": { schema: classifyRequestSchema } },
            },
        },
        responses: {
            200: {
                content: { "application/json": { schema: classifyResponseSchema } },
                description: "Classification result with tier, score dimensions, and recommended model",
            },
        },
        summary: "Classify a prompt without invoking an LLM",
        tags: ["Classification"],
    },
    (c) => {
        const body = c.req.valid("json");
        const result = computeClassification(
            body.messages as ModelMessage[],
            body.tools ? Object.keys(body.tools).length : 0,
            body.userTier,
            body.preferredQuality,
            (body.routingProfile ?? "auto") as RoutingProfile,
        );

        return c.json(result, 200);
    },
);

const batchRequestSchema = z.object({
    prompts: z.array(classifyRequestSchema).min(1).max(100),
});

const batchResponseSchema = z.object({
    count: z.number(),
    results: z.array(classifyResponseSchema),
});

// POST /v1/classify/batch — batch prompt classification
classifyRouter.openapi(
    {
        method: "post",
        // Tighter cap on /batch since each call multiplies cost by up to 100x.
        middleware: [classifyAuth, classifyRateLimit("classify-batch", 0.2)] as const,
        path: "/v1/classify/batch",
        request: {
            body: {
                content: { "application/json": { schema: batchRequestSchema } },
            },
        },
        responses: {
            200: {
                content: { "application/json": { schema: batchResponseSchema } },
                description: "Array of classification results",
            },
        },
        summary: "Classify multiple prompts without invoking any LLM",
        tags: ["Classification"],
    },
    (c) => {
        const body = c.req.valid("json");
        const results = body.prompts.map((p) =>
            computeClassification(
                p.messages as ModelMessage[],
                p.tools ? Object.keys(p.tools).length : 0,
                p.userTier,
                p.preferredQuality,
                (p.routingProfile ?? "auto") as RoutingProfile,
            ),
        );

        return c.json({ count: results.length, results }, 200);
    },
);

export { classifyRouter };
