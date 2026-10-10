import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";

import type { AppEnv } from "../index.js";
import { classifyImage } from "../lib/nsfw-classify.js";

const NsfwResponseSchema = z.object({
    drawing: z.number().describe("Probability of cartoon/anime/illustration content"),
    hentai: z.number().describe("Probability of explicit animated/drawn sexual content"),
    isNsfw: z.boolean().describe("Whether the image exceeds NSFW thresholds"),
    neutral: z.number().describe("Probability of safe-for-work content"),
    porn: z.number().describe("Probability of explicit photographic sexual content"),
    sexy: z.number().describe("Probability of suggestive or mildly explicit content"),
    topCategory: z.enum(["drawing", "hentai", "neutral", "porn", "sexy"]).describe("Category with the highest score"),
});

const ClassifyErrorSchema = z.object({
    details: z.string().optional(),
    error: z.string(),
});

const classifyRoute = createRoute({
    // No auth middleware: this Worker has no public URL (`workers_dev: false`, no
    // route), so the backend's service binding is the only way in.
    description: "Classify an image for NSFW content. The request body must be the raw image bytes.",
    method: "post",
    path: "/classify",
    request: {
        headers: z.object({
            "content-type": z.string().describe("MIME type of the image"),
        }),
    },
    responses: {
        200: {
            content: { "application/json": { schema: NsfwResponseSchema } },
            description: "NSFW classification scores",
        },
        400: {
            content: { "application/json": { schema: ClassifyErrorSchema } },
            description: "Bad request (empty body)",
        },
        413: {
            content: { "application/json": { schema: ClassifyErrorSchema } },
            description: "Payload too large",
        },
        500: {
            content: { "application/json": { schema: ClassifyErrorSchema } },
            description: "Classification failed",
        },
    },
    summary: "Classify image for NSFW content",
    tags: ["Classification"],
});

const ALLOWED_MIME_TYPES = new Set(["image/bmp", "image/gif", "image/jpeg", "image/png", "image/webp"]);

const classifyRouter = new OpenAPIHono<{ Bindings: AppEnv }>();

classifyRouter.openapi(classifyRoute, async (c) => {
    // Validate MIME type before calling Workers AI
    const contentType = (c.req.header("Content-Type") ?? "").split(";", 1)[0]!.trim().toLowerCase();

    if (!ALLOWED_MIME_TYPES.has(contentType)) {
        return c.json({ error: "Unsupported media type. Accepted: image/jpeg, image/png, image/gif, image/webp, image/bmp." }, 400);
    }

    const body = await c.req.arrayBuffer();

    if (body.byteLength === 0) {
        return c.json({ error: "Empty request body" }, 400);
    }

    // 10 MB limit
    if (body.byteLength > 10 * 1024 * 1024) {
        return c.json({ error: "File too large. Maximum size is 10 MB." }, 413);
    }

    const imageBytes = new Uint8Array(body);
    const scores = await classifyImage(c.env, imageBytes);

    return c.json(scores, 200);
});

export { classifyRouter };
