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

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

const readBodyCapped = async (request: Request, maxBytes: number): Promise<Uint8Array | undefined> => {
    const chunks: Uint8Array[] = [];
    let total = 0;

    if (request.body) {
        for await (const chunk of request.body) {
            total += chunk.byteLength;

            if (total > maxBytes) {
                return undefined;
            }

            chunks.push(chunk);
        }
    }

    const body = new Uint8Array(total);
    let offset = 0;

    for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
    }

    return body;
};

const classifyRouter = new OpenAPIHono<{ Bindings: AppEnv }>();

classifyRouter.openapi(classifyRoute, async (c) => {
    // Validate MIME type before calling Workers AI
    const contentType = (c.req.header("Content-Type") ?? "").split(";", 1)[0]!.trim().toLowerCase();

    if (!ALLOWED_MIME_TYPES.has(contentType)) {
        return c.json({ error: "Unsupported media type. Accepted: image/jpeg, image/png, image/gif, image/webp, image/bmp." }, 400);
    }

    const declaredLength = Number(c.req.header("Content-Length") ?? 0);

    if (declaredLength > MAX_IMAGE_BYTES) {
        return c.json({ error: "File too large. Maximum size is 10 MB." }, 413);
    }

    const imageBytes = await readBodyCapped(c.req.raw, MAX_IMAGE_BYTES);

    if (!imageBytes) {
        return c.json({ error: "File too large. Maximum size is 10 MB." }, 413);
    }

    if (imageBytes.byteLength === 0) {
        return c.json({ error: "Empty request body" }, 400);
    }

    const scores = await classifyImage(c.env, imageBytes);

    return c.json(scores, 200);
});

export { classifyRouter };
