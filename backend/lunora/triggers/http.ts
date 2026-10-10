import type { HttpActionCtx } from "lunorash/server";

/**
 * Trigger Webhook HTTP Handler
 *
 * Handles incoming webhook requests for trigger execution.
 * Verifies HMAC-SHA256 signatures and schedules trigger execution.
 *
 * Endpoint pattern: POST /triggers/webhook/{triggerId}
 *
 * Signing scheme (documented in the trigger settings UI):
 *   X-Neore-Timestamp: <unix seconds>
 *   X-Signature-256:   sha256=<hex HMAC-SHA256(secret, "<timestamp>.<raw body>")>
 * A timestamp more than `SIGNED_REQUEST_WINDOW_MS` (`lib/crypto.ts`) from now is
 * refused, and an accepted signature is claimed once for longer than that window
 * (`lib/claim-once.ts`), so a captured
 * request cannot be replayed. The old body-only signature had neither and is no
 * longer accepted; nor is an unsigned request (legacy rows without a secret).
 */
import { internal } from "../_generated/internal";
import type { Doc, Id } from "../_generated/dataModel";
import { TRIGGER_CLAIM_TTL_MS } from "../lib/claim-once";
import { hmacSha256Hex, isWithinWindow, SIGNED_REQUEST_WINDOW_MS, timingSafeEqual } from "../lib/crypto";
import { decryptKey } from "../lib/encryption";
import { httpScheduler } from "../lib/http-scheduler";
import { checkRateLimit } from "../lib/rate-limiter";

const DIGITS_ONLY = /^\d{1,12}$/u;

/**
 * The trigger fields this handler reads.
 *
 * `internal.triggers.functions.getTriggerInternal` is declared `.output(v.any())`,
 * so `runQuery` hands back an untyped value. Naming the subset here narrows it once,
 * at the call site, instead of re-casting at every field access — and keeps the field
 * types (the `type` union, `enabled: boolean`) from the generated `Doc<"triggers">`.
 */
type WebhookTrigger = Pick<Doc<"triggers">, "enabled" | "type" | "userId" | "webhookSecret">;

/**
 * Handle an incoming webhook request for a trigger.
 *
 * Verifies the HMAC-SHA256 signature (if configured), then schedules
 * the trigger execution as a background action.
 */
const handleTriggerWebhook = async (context: HttpActionCtx, request: Request, triggerId: string): Promise<Response> => {
    try {
        // 0. Validate trigger ID format before casting
        if (!triggerId || typeof triggerId !== "string" || triggerId.length === 0) {
            return Response.json(
                { error: "Not found" },
                {
                    headers: { "Content-Type": "application/json" },
                    status: 404,
                },
            );
        }

        // 1. Fetch the trigger
        let trigger: WebhookTrigger | null;

        try {
            trigger = await context.runQuery(internal.triggers.functions.getTriggerInternal, {
                triggerId: triggerId as Id<"triggers">,
            });
        } catch {
            // Invalid ID format throws — treat as not found
            return Response.json(
                { error: "Not found" },
                {
                    headers: { "Content-Type": "application/json" },
                    status: 404,
                },
            );
        }

        if (!trigger) {
            // Use generic "Not found" to avoid leaking trigger existence info
            return Response.json(
                { error: "Not found" },
                {
                    headers: { "Content-Type": "application/json" },
                    status: 404,
                },
            );
        }

        if (trigger.enabled !== true) {
            // Use generic "Not found" to avoid leaking trigger state
            return Response.json(
                { error: "Not found" },
                {
                    headers: { "Content-Type": "application/json" },
                    status: 404,
                },
            );
        }

        if (trigger.type !== "webhook") {
            return Response.json(
                { error: "Not found" },
                {
                    headers: { "Content-Type": "application/json" },
                    status: 404,
                },
            );
        }

        // 2. Read the request body (enforce 1MB size limit to prevent DoS)
        const contentLength = request.headers.get("content-length");
        const MAX_PAYLOAD_SIZE = 1024 * 1024; // 1MB

        if (contentLength && Number.parseInt(contentLength, 10) > MAX_PAYLOAD_SIZE) {
            return Response.json(
                { error: "Payload too large" },
                {
                    headers: { "Content-Type": "application/json" },
                    status: 413,
                },
            );
        }

        const body = await request.text();

        if (body.length > MAX_PAYLOAD_SIZE) {
            return Response.json(
                { error: "Payload too large" },
                {
                    headers: { "Content-Type": "application/json" },
                    status: 413,
                },
            );
        }

        // 3. Verify the timestamped HMAC-SHA256 signature. A trigger without a
        //    secret (legacy rows) is refused: unsigned delivery is no delivery.
        const encryptedSecret = trigger.webhookSecret;
        const signature = request.headers.get("x-signature-256");
        const timestamp = request.headers.get("x-neore-timestamp");

        if (!encryptedSecret || !signature || !timestamp || !DIGITS_ONLY.test(timestamp)) {
            return Response.json({ error: "Missing or invalid signature headers" }, { headers: { "Content-Type": "application/json" }, status: 401 });
        }

        if (!isWithinWindow(Number(timestamp) * 1000, SIGNED_REQUEST_WINDOW_MS)) {
            return Response.json({ error: "Stale or future timestamp" }, { headers: { "Content-Type": "application/json" }, status: 401 });
        }

        // Decrypt the stored secret (supports both encrypted v1: and legacy plaintext)
        const plaintextSecret = encryptedSecret.startsWith("v1:") ? await decryptKey(encryptedSecret, "tool-keys") : encryptedSecret;

        if (!(await verifyHmacSignature(plaintextSecret, `${timestamp}.${body}`, signature))) {
            return Response.json({ error: "Invalid signature" }, { headers: { "Content-Type": "application/json" }, status: 401 });
        }

        // Capped per trigger only once the sender is proven. Charged before the
        // signature check, anyone who knew the trigger id could spend the quota
        // with junk and lock the owner's real deliveries out.
        const limited = await checkRateLimit(context, "triggers/webhook", { key: triggerId, throws: false });

        if (!limited.ok) {
            return Response.json({ error: "Too many requests" }, { headers: { "Content-Type": "application/json" }, status: 429 });
        }

        // A valid signature seen before is a replay: answer 200 (the sender did
        // deliver it once) and run nothing.
        const claim = { key: `${triggerId}:${normalizeSignature(signature)}`, scope: "trigger-webhook" };
        const firstDelivery = await context.runMutation(internal.lib.claim_once.claimKey, { ...claim, ttlMs: TRIGGER_CLAIM_TTL_MS, userId: trigger.userId });

        if (!firstDelivery) {
            return Response.json({ duplicate: true, ok: true }, { headers: { "Content-Type": "application/json" }, status: 200 });
        }

        // 4. Schedule trigger execution. The claim is already committed, so a
        //    failure here must give it back — otherwise the sender's retry of
        //    this same delivery reads as a replay, and it never runs at all.
        try {
            await httpScheduler(context).runAfter(0, internal.triggers.execute.executeTrigger, {
                payload: body || undefined,
                triggerId: triggerId as Id<"triggers">,
            });
        } catch (error) {
            await context.runMutation(internal.lib.claim_once.releaseKey, claim);

            throw error;
        }

        return Response.json(
            { message: "Trigger scheduled", ok: true },
            {
                headers: { "Content-Type": "application/json" },
                status: 200,
            },
        );
    } catch (error) {
        console.error(`[Triggers] Webhook handler error for ${triggerId}:`, error);

        return Response.json(
            { error: "Internal server error" },
            {
                headers: { "Content-Type": "application/json" },
                status: 500,
            },
        );
    }
};

/** `sha256=<hex>` or bare hex, lower-cased — also the dedupe key. */
const normalizeSignature = (signature: string): string => (signature.startsWith("sha256=") ? signature.slice(7) : signature).toLowerCase();

/**
 * Verify HMAC-SHA256 signature.
 * Supports both raw hex and "sha256=hex" format (GitHub-style).
 */
export const verifyHmacSignature = async (secret: string, payload: string, signature: string): Promise<boolean> =>
    timingSafeEqual(await hmacSha256Hex(secret, payload), normalizeSignature(signature));

export default handleTriggerWebhook;
