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
 * request cannot be replayed. The old body-only `X-Signature-256` had neither and
 * is no longer accepted; nor is an unsigned request (legacy rows without a secret).
 *
 * Senders that cannot add a timestamp (they sign the raw body only) are served by
 * a trigger whose `webhookSignatureScheme` is "native" (unset means "timestamped"):
 *   X-Hub-Signature-256: sha256=<hex HMAC-SHA256(secret, "<raw body>")>
 * A trigger accepts ONLY its own scheme's headers and refuses a request carrying
 * the other's. Both schemes key the HMAC with the same secret, so a captured
 * timestamped signature over "<ts>.<body>" would otherwise verify as a native
 * signature of the body "<ts>.<body>". (The key is not derived per scheme because
 * a native sender signs with the raw secret.)
 *
 * A native signature carries no timestamp, so the ONLY replay defence is the same
 * signature-keyed claim, and it lasts as long as the claim does:
 * `TRIGGER_CLAIM_TTL_MS`. A body-only request replayed after that window is
 * accepted again. Nothing outside the signed bytes (a delivery-id header, say) is
 * ever trusted: it is not covered by the signature, so a claim keyed on it would
 * let anyone replay a captured body under a fresh id.
 */
import { internal } from "../_generated/internal";
import type { Doc, Id } from "../_generated/dataModel";
import { TRIGGER_CLAIM_TTL_MS } from "../lib/claim-once";
import { hmacSha256Hex, isWithinWindow, SIGNED_REQUEST_WINDOW_MS, timingSafeEqual } from "../lib/crypto";
import { decryptKey } from "../lib/encryption";
import { httpScheduler } from "../lib/http-scheduler";
import { checkRateLimit } from "../lib/rate-limiter";
import { decodeStrict, evaluateFilters, MAX_WEBHOOK_BODY_BYTES } from "./filters";

const DIGITS_ONLY = /^\d{1,12}$/u;

/** `X-Hub-Signature-256` is always `sha256=<64 hex>`; anything else is refused before any HMAC work. */
const NATIVE_SIGNATURE = /^sha256=[\da-f]{64}$/iu;

/**
 * The trigger fields this handler reads.
 *
 * `internal.triggers.functions.getTriggerInternal` is declared `.output(v.any())`,
 * so `runQuery` hands back an untyped value. Naming the subset here narrows it once,
 * at the call site, instead of re-casting at every field access — and keeps the field
 * types (the `type` union, `enabled: boolean`) from the generated `Doc<"triggers">`.
 */
type WebhookTrigger = Pick<Doc<"triggers">, "enabled" | "filters" | "type" | "userId" | "webhookSecret" | "webhookSignatureScheme">;

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

        if (contentLength && Number.parseInt(contentLength, 10) > MAX_WEBHOOK_BODY_BYTES) {
            return Response.json(
                { error: "Payload too large" },
                {
                    headers: { "Content-Type": "application/json" },
                    status: 413,
                },
            );
        }

        // The signature covers the bytes the sender sent. Verify those, not a decoded
        // string: `text()` strips a BOM and replaces invalid UTF-8, so a body that is
        // not clean UTF-8 would never match the signature it was signed with.
        const rawBody = new Uint8Array(await request.arrayBuffer());

        if (rawBody.byteLength > MAX_WEBHOOK_BODY_BYTES) {
            return Response.json(
                { error: "Payload too large" },
                {
                    headers: { "Content-Type": "application/json" },
                    status: 413,
                },
            );
        }

        const body = new TextDecoder().decode(rawBody);

        // 3. Verify the HMAC-SHA256 signature. A trigger without a secret
        //    (legacy rows) is refused: unsigned delivery is no delivery.
        const encryptedSecret = trigger.webhookSecret;
        const delivery = readSignedDelivery(request.headers, rawBody, trigger.webhookSignatureScheme ?? "timestamped");

        if (!encryptedSecret || "error" in delivery) {
            return Response.json(
                { error: "error" in delivery ? delivery.error : MISSING_SIGNATURE },
                { headers: { "Content-Type": "application/json" }, status: 401 },
            );
        }

        const { presented, signedPayload } = delivery;

        // Decrypt the stored secret (supports both encrypted v1: and legacy plaintext)
        const plaintextSecret = encryptedSecret.startsWith("v1:") ? await decryptKey(encryptedSecret, "tool-keys") : encryptedSecret;

        if (!(await verifyHmacSignature(plaintextSecret, signedPayload, presented))) {
            return Response.json({ error: "Invalid signature" }, { headers: { "Content-Type": "application/json" }, status: 401 });
        }

        // Capped per trigger only once the sender is proven. Charged before the
        // signature check, anyone who knew the trigger id could spend the quota
        // with junk and lock the owner's real deliveries out.
        const limited = await checkRateLimit(context, "triggers/webhook", { failMode: "open", key: triggerId, throws: false });

        if (!limited.ok) {
            return Response.json({ error: "Too many requests" }, { headers: { "Content-Type": "application/json" }, status: 429 });
        }

        // A valid signature seen before is a replay: answer 200 (the sender did
        // deliver it once) and run nothing.
        const claim = { key: `${triggerId}:${normalizeSignature(presented)}`, scope: "trigger-webhook" };
        const claimedAt = await context.runMutation(internal.lib.claim_once.claimKeyFenced, { ...claim, ttlMs: TRIGGER_CLAIM_TTL_MS, userId: trigger.userId });

        if (claimedAt === null) {
            return Response.json({ duplicate: true, ok: true }, { headers: { "Content-Type": "application/json" }, status: 200 });
        }

        // 4. Payload filters, on the body only now that its signature is proven. A
        //    filtered delivery RELEASES its claim once recorded: the owner may fix the
        //    filters and redeliver the same signed body within the claim's TTL, and that
        //    replay must be evaluated again. A replay that still misses writes only the
        //    one collapsed history row. It runs nothing, so it is not charged
        //    (`admitTriggerRun` lives in the execution) and does not count as a run.
        //    The claim travels to the execution, which gives it back too if admission
        //    refuses the delivery against filters saved after this check.
        //    202, not 200: the delivery was accepted and deliberately not acted on.
        //    The body is decoded strictly for this: the lossy decode above turns invalid
        //    UTF-8 into U+FFFD, which could let bytes that are not JSON parse as JSON.
        //    A body that does not decode is evaluated as the empty (non-JSON) string.
        //        The run carries `invalidUtf8` so admission evaluates the same text.
        const strictBody = decodeStrict(rawBody);
        const verdict = evaluateFilters(trigger.filters, strictBody ?? "");

        if (!verdict.matched) {
            try {
                await context.runMutation(internal.triggers.functions.recordFilteredExecution, {
                    reason: verdict.reason.slice(0, 500),
                    triggerId: triggerId as Id<"triggers">,
                });
            } catch (error) {
                await context.runMutation(internal.lib.claim_once.releaseKey, claim);

                throw error;
            }

            await context.runMutation(internal.lib.claim_once.releaseKey, claim);

            return Response.json(
                {
                    filter: { op: verdict.filter.op, path: verdict.filter.path, value: verdict.filter.value ?? null },
                    ok: true,
                    outcome: "filtered",
                    reason: verdict.reason,
                },
                { headers: { "Content-Type": "application/json" }, status: 202 },
            );
        }

        // 5. Schedule trigger execution. The claim is already committed, so a
        //    failure here must give it back — otherwise the sender's retry of
        //    this same delivery reads as a replay, and it never runs at all.
        try {
            await httpScheduler(context).runAfter(0, internal.triggers.execute.executeTrigger, {
                claim: { ...claim, claimedAt },
                invalidUtf8: strictBody === null ? true : undefined,
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

const MISSING_SIGNATURE = "Missing or invalid signature headers";

type SignedDelivery = { presented: string; signedPayload: Uint8Array } | { error: string };

/**
 * Read the signature the trigger's configured scheme expects, and say what was
 * signed. A request carrying the OTHER scheme's headers is refused outright, so
 * one scheme's signature is never tried as the other's. The timestamp is checked
 * here; the HMAC itself by the caller.
 */
const readSignedDelivery = (headers: Headers, body: Uint8Array, scheme: "native" | "timestamped"): SignedDelivery => {
    const signature = headers.get("x-signature-256");
    const timestamp = headers.get("x-neore-timestamp");
    const native = headers.get("x-hub-signature-256");

    if (scheme === "native") {
        if (signature !== null || timestamp !== null || !native || !NATIVE_SIGNATURE.test(native)) {
            return { error: MISSING_SIGNATURE };
        }

        return { presented: native, signedPayload: body };
    }

    if (native !== null || !signature || !timestamp || !DIGITS_ONLY.test(timestamp)) {
        return { error: MISSING_SIGNATURE };
    }

    if (!isWithinWindow(Number(timestamp) * 1000, SIGNED_REQUEST_WINDOW_MS)) {
        return { error: "Stale or future timestamp" };
    }

    const prefix = new TextEncoder().encode(`${timestamp}.`);
    const signedPayload = new Uint8Array(prefix.byteLength + body.byteLength);

    signedPayload.set(prefix);
    signedPayload.set(body, prefix.byteLength);

    return { presented: signature, signedPayload };
};

/** `sha256=<hex>` or bare hex, lower-cased — also the dedupe key. */
const normalizeSignature = (signature: string): string => (signature.startsWith("sha256=") ? signature.slice(7) : signature).toLowerCase();

/**
 * Verify HMAC-SHA256 signature.
 * Supports both raw hex and "sha256=hex" format (GitHub-style).
 */
export const verifyHmacSignature = async (secret: string, payload: string | Uint8Array, signature: string): Promise<boolean> =>
    timingSafeEqual(await hmacSha256Hex(secret, payload), normalizeSignature(signature));

export default handleTriggerWebhook;
