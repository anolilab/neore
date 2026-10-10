/**
 * Embeddings Worker
 *
 * Cloudflare Worker that generates text embeddings using Workers AI.
 * Replaces Google AI text-embedding-004 for the memory and knowledge systems.
 *
 * Default model: `@cf/baai/bge-base-en-v1.5` (768 dimensions) to match the
 * existing vector table used by the memory system.
 *
 * Auth: Requests are verified via HMAC-SHA256 signatures (X-Signature + X-Timestamp).
 * The SIGNING_SECRET env var must be set; requests are rejected if it is missing.
 */
import { Hono } from "hono";
import { z } from "zod";

interface Env {
    AI: Ai;
    NODE_ENV: string;
    SIGNING_SECRET: string;
}

const app = new Hono<{ Bindings: Env }>();

// ─── Allowed Models ─────────────────────────────────────────────────────────────

const ALLOWED_MODELS: Record<string, { description: string; dimensions: number }> = {
    "@cf/baai/bge-base-en-v1.5": { description: "English, balanced", dimensions: 768 },
    "@cf/baai/bge-large-en-v1.5": { description: "English, high quality", dimensions: 1024 },
    "@cf/baai/bge-small-en-v1.5": { description: "English, fast", dimensions: 384 },
};

const ALLOWED_MODEL_IDS = Object.keys(ALLOWED_MODELS);

// ─── Request Schema ─────────────────────────────────────────────────────────────

const embedSchema = z.object({
    model: z.string().optional(), // Override model, must be in ALLOWED_MODELS
    texts: z.array(z.string()).min(1).max(100),
});

// ─── HMAC-SHA256 request signature verification ────────────────────────────────
// Aligned with document-parser's signing pattern

/** Strict numeric timestamp. Hoisted so it is compiled once, not per request. */
const NUMERIC_RE = /^\d+$/;

const REPLAY_WINDOW_MS = 30_000;

const sha256Hex = async (data: ArrayBuffer): Promise<string> => {
    const hash = await crypto.subtle.digest("SHA-256", data);

    return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
};

const hmacSha256Hex = async (secret: string, message: string): Promise<string> => {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { hash: "SHA-256", name: "HMAC" }, false, ["sign"]);
    const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(message));

    return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
};

/** Timing-safe comparison via HMAC double-signing. */
const timingSafeEqual = async (secret: string, a: string, b: string): Promise<boolean> => {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { hash: "SHA-256", name: "HMAC" }, false, ["sign"]);
    const sigA = await crypto.subtle.sign("HMAC", key, encoder.encode(a));
    const sigB = await crypto.subtle.sign("HMAC", key, encoder.encode(b));
    const viewA = new Uint8Array(sigA);
    const viewB = new Uint8Array(sigB);
    let diff = 0;

    for (const [i, element] of viewA.entries()) {
        diff |= element! ^ viewB[i]!;
    }

    return diff === 0;
};

const verifyHmac = async (request: Request, secret: string): Promise<boolean> => {
    const signature = request.headers.get("X-Signature");
    const timestamp = request.headers.get("X-Timestamp");

    if (!signature || !timestamp) return false;

    if (!NUMERIC_RE.test(timestamp)) return false;

    const ts = Number(timestamp);

    if (Math.abs(Date.now() - ts) > REPLAY_WINDOW_MS) return false;

    const body = await request.clone().arrayBuffer();
    const bodyHash = await sha256Hex(body);
    const path = new URL(request.url).pathname;
    const message = `${request.method}\n${path}\n${timestamp}\n${bodyHash}`;
    const expected = await hmacSha256Hex(secret, message);

    return timingSafeEqual(secret, signature, expected);
};

// ─── Rate Limiting ──────────────────────────────────────────────────────────────
// Simple sliding-window rate limiter per Worker isolate.
// Workers AI already has account-level limits, but this adds burst protection.

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 120;
const requestTimestamps: number[] = [];

const shouldAllowRequest = (): boolean => {
    const now = Date.now();

    // Evict expired entries
    while (requestTimestamps.length > 0 && requestTimestamps[0]! < now - RATE_LIMIT_WINDOW_MS) {
        requestTimestamps.shift();
    }

    if (requestTimestamps.length >= RATE_LIMIT_MAX_REQUESTS) {
        return false;
    }

    requestTimestamps.push(now);

    return true;
};

// ─── Embedding Endpoint ─────────────────────────────────────────────────────────

const DEFAULT_MODEL = "@cf/baai/bge-base-en-v1.5"; // 768 dimensions — matches memory vector table

app.post("/embed", async (c) => {
    // Auth is mandatory — reject if SIGNING_SECRET is not configured
    const signingSecret = c.env.SIGNING_SECRET;

    if (!signingSecret) {
        return c.json({ error: "Server misconfiguration: SIGNING_SECRET not set", success: false }, 500);
    }

    const valid = await verifyHmac(c.req.raw, signingSecret);

    if (!valid) {
        console.warn(`[embeddings] Auth failed from ${c.req.header("CF-Connecting-IP") ?? "unknown"}`);

        return c.json({ error: "Unauthorized", success: false }, 401);
    }

    // Rate limiting
    if (!shouldAllowRequest()) {
        return c.json({ error: "Rate limit exceeded", success: false }, 429);
    }

    // Parse request — catch malformed JSON
    let body: unknown;

    try {
        body = await c.req.json();
    } catch {
        return c.json({ error: "Invalid JSON body", success: false }, 400);
    }

    const parsed = embedSchema.safeParse(body);

    if (!parsed.success) {
        return c.json({ error: `Invalid request: ${parsed.error.message}`, success: false }, 400);
    }

    const { model = DEFAULT_MODEL, texts } = parsed.data;

    // Validate model against allowlist to prevent arbitrary model injection
    if (!ALLOWED_MODEL_IDS.includes(model)) {
        return c.json(
            {
                error: `Unknown model: ${model}. Allowed models: ${ALLOWED_MODEL_IDS.join(", ")}`,
                success: false,
            },
            400,
        );
    }

    try {
        const result = (await c.env.AI.run(model as keyof AiModels, {
            text: texts,
        })) as unknown as AiTextEmbeddingsOutput;

        return c.json({
            dimensions: result.data?.[0]?.length ?? 0,
            embeddings: result.data,
            model,
            success: true,
        });
    } catch (error) {
        return c.json(
            {
                error: `Embedding generation failed: ${error instanceof Error ? error.message : String(error)}`,
                success: false,
            },
            500,
        );
    }
});

// ─── Model Info ─────────────────────────────────────────────────────────────────

/** Static catalog payload — the model list never changes at runtime. */
const MODEL_INFO_RESPONSE = {
    available: Object.entries(ALLOWED_MODELS).map(([id, info]) => {
        return { id, ...info };
    }),
    default: DEFAULT_MODEL,
};

app.get("/models", (c) => c.json(MODEL_INFO_RESPONSE));

// Health check
app.get("/health", (c) => c.json({ service: "embeddings", status: "ok" }));

export default app;
