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
 * accepted again. For these two schemes nothing outside the signed bytes (a
 * delivery-id header, say) is ever trusted: it is not covered by the signature, so
 * a claim keyed on it would let anyone replay a captured body under a fresh id.
 *
 * One more sender, with its own scheme (`triggers/presets.ts`):
 *   gitlab-token: X-Gitlab-Token: <secret>, sent as plain text, plus
 *                 X-Gitlab-Event-UUID: <uuid>. GitLab does not sign the body and sends
 *                 no timestamp, so the token is a BEARER credential and the only thing
 *                 that can mark a delivery as seen is the UUID. A delivery without one
 *                 is refused (401, after the token check). The UUID is unsigned, so it
 *                 is no defence against a holder of the token, who can forge any body
 *                 under any id anyway; it closes the replay of a CAPTURED delivery,
 *                 which repeats the UUID. Each accepted delivery is kept for the
 *                 trigger's whole life as a `webhookDeliveries` row (`deliveries.ts`),
 *                 keyed on the UUID AND the SHA-256 of the body: GitLab documents that
 *                 recursive webhooks share one event UUID, so the UUID alone would
 *                 refuse a distinct delivery. That row replaces the 15-minute body
 *                 claim, which it makes redundant. A claim keyed on the token would
 *                 swallow every delivery after the first.
 *
 * A missing or empty secret is refused for every scheme (fail closed).
 */
import { internal } from "../_generated/internal";
import type { Doc, Id } from "../_generated/dataModel";
import { TRIGGER_CLAIM_TTL_MS } from "../lib/claim-once";
import { hmacSha256Hex, isWithinWindow, SIGNED_REQUEST_WINDOW_MS, secretsMatch, sha256Hex, timingSafeEqual } from "../lib/crypto";
import { decryptKey } from "../lib/encryption";
import { httpScheduler } from "../lib/http-scheduler";
import { checkRateLimit } from "../lib/rate-limiter";
import { MAX_DELIVERY_ID_LENGTH } from "./deliveries";
import { decodeStrict, evaluateFilters, MAX_WEBHOOK_BODY_BYTES } from "./filters";
import type { WebhookSignatureScheme } from "./validators";

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

        // 3. Verify the delivery against the trigger's scheme. A trigger without a
        //    secret (legacy rows) is refused: unsigned delivery is no delivery.
        const encryptedSecret = trigger.webhookSecret;
        const schemeName = trigger.webhookSignatureScheme ?? "timestamped";
        const scheme = SCHEMES[schemeName];
        const delivery = readDelivery(request.headers, rawBody, schemeName);

        if (!encryptedSecret || "error" in delivery) {
            return Response.json(
                { error: "error" in delivery ? delivery.error : MISSING_SIGNATURE },
                { headers: { "Content-Type": "application/json" }, status: 401 },
            );
        }

        // Decrypt the stored secret (supports both encrypted v1: and legacy plaintext)
        const plaintextSecret = encryptedSecret.startsWith("v1:") ? await decryptKey(encryptedSecret, "tool-keys") : encryptedSecret;

        if (!(await scheme.verify(delivery, plaintextSecret))) {
            return Response.json({ error: "Invalid signature" }, { headers: { "Content-Type": "application/json" }, status: 401 });
        }

        // Only once the sender is proven, so an unauthenticated caller learns nothing about it.
        if (scheme.requiresDeliveryId && (!delivery.deliveryId || delivery.deliveryId.length > MAX_DELIVERY_ID_LENGTH)) {
            return Response.json({ error: MISSING_DELIVERY_ID }, { headers: { "Content-Type": "application/json" }, status: 401 });
        }

        // Capped per trigger only once the sender is proven. Charged before the
        // signature check, anyone who knew the trigger id could spend the quota
        // with junk and lock the owner's real deliveries out.
        const limited = await checkRateLimit(context, "triggers/webhook", { failMode: "open", key: triggerId, throws: false });

        if (!limited.ok) {
            return Response.json({ error: "Too many requests" }, { headers: { "Content-Type": "application/json" }, status: 429 });
        }

        // A delivery seen before is a replay: answer 200 (the sender did deliver it once) and run nothing.
        const taken = await takeReplayGuard(context, { delivery, rawBody, scheme, trigger, triggerId });

        if (taken === null) {
            return Response.json({ duplicate: true, ok: true }, { headers: { "Content-Type": "application/json" }, status: 200 });
        }

        // 4. Payload filters, on the body only now that its signature is proven. A
        //    filtered delivery RELEASES its claim once recorded: the owner may fix the
        //    filters and redeliver the same signed body within the claim's TTL, and that
        //    replay must be evaluated again. A replay that still misses writes only the
        //    one collapsed history row. It runs nothing, so it is not charged
        //    (`admitTriggerRun` lives in the execution) and does not count as a run.
        //    The claim (or delivery record) travels to the execution, which gives it back too if admission
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
                await taken.giveBack();

                throw error;
            }

            await taken.giveBack();

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
                ...taken.args,
                invalidUtf8: strictBody === null ? true : undefined,
                payload: body || undefined,
                triggerId: triggerId as Id<"triggers">,
            });
        } catch (error) {
            await taken.giveBack();

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

const MISSING_DELIVERY_ID = "Missing or invalid delivery identifier";

/** What a delivery presented, and the bytes its credential covers. */
interface Delivery {
    /** The sender's own identifier for the delivery, when its scheme carries one (`requiresDeliveryId`). */
    deliveryId?: string;
    presented: string;
    signedPayload: Uint8Array;
}

/** What one signature scheme does with a request. The handler looks the trigger's scheme up here and checks none by name. */
interface SchemeHandler {
    /** The headers this scheme owns. A trigger refuses a request carrying any header of a scheme it does not use. */
    headers: ReadonlyArray<string>;
    /** Read the credential and the bytes it covers, or say why the request is refused. Timestamps are checked here. */
    read: (headers: Headers, body: Uint8Array) => Delivery | { error: string };
    /**
     * The credential is the same on every delivery, so the sender's delivery id is the only replay defence:
     * a verified delivery without one is refused, and each accepted one is recorded for the trigger's life.
     */
    requiresDeliveryId?: boolean;
    /** Whether the delivery proves knowledge of the secret. */
    verify: (delivery: Delivery, secret: string) => Promise<boolean>;
}

const verifyHmac = async (delivery: Delivery, secret: string): Promise<boolean> =>
    await verifyHmacSignature(secret, delivery.signedPayload, delivery.presented);

/** One handler per scheme. The record type is exhaustive, so a scheme added to the validator fails to compile until it has one. */
const SCHEMES: Record<WebhookSignatureScheme, SchemeHandler> = {
    "gitlab-token": {
        // Not in `headers`: that list marks a request as another scheme's, and the UUID is only read here.
        headers: ["x-gitlab-token"],
        read: (headers, body) => {
            const token = headers.get("x-gitlab-token");
            const deliveryId = headers.get("x-gitlab-event-uuid")?.trim();

            // A token signs nothing; the body rides along only so the shape is shared.
            return token ? { deliveryId: deliveryId || undefined, presented: token, signedPayload: body } : { error: MISSING_SIGNATURE };
        },
        requiresDeliveryId: true,
        // Compared through hashes, so neither the content nor the length of the secret leaks.
        verify: async (delivery, secret) => await secretsMatch(delivery.presented, secret),
    },
    native: {
        headers: ["x-hub-signature-256"],
        read: (headers, body) => {
            const native = headers.get("x-hub-signature-256");

            return native && NATIVE_SIGNATURE.test(native) ? { presented: native, signedPayload: body } : { error: MISSING_SIGNATURE };
        },
        verify: verifyHmac,
    },
    timestamped: {
        headers: ["x-signature-256", "x-neore-timestamp"],
        read: (headers, body) => {
            const signature = headers.get("x-signature-256");
            const timestamp = headers.get("x-neore-timestamp");

            if (!signature || !timestamp || !DIGITS_ONLY.test(timestamp)) {
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
        },
        verify: verifyHmac,
    },
};

/** What a delivery took to be accepted once: how the execution gives it back, and how this handler does. */
interface ReplayGuard {
    /** Handed to `executeTrigger`, which gives the claim back if admission refuses the delivery. */
    args: { claim: { claimedAt: number; key: string; scope: string } } | { deliveryRecord: Id<"webhookDeliveries"> };
    giveBack: () => Promise<void>;
}

/**
 * Takes the once-only guard of a verified delivery: the permanent record for a scheme that requires a
 * delivery id, otherwise the signature's claim for `TRIGGER_CLAIM_TTL_MS`. `null` when it was taken before.
 */
const takeReplayGuard = async (
    context: HttpActionCtx,
    {
        delivery,
        rawBody,
        scheme,
        trigger,
        triggerId,
    }: { delivery: Delivery; rawBody: Uint8Array; scheme: SchemeHandler; trigger: WebhookTrigger; triggerId: string },
): Promise<ReplayGuard | null> => {
    if (scheme.requiresDeliveryId) {
        // The handler refused a delivery without one before getting here.
        if (!delivery.deliveryId) {
            throw new Error("A delivery id is required");
        }

        const recordId = await context.runMutation(internal.triggers.deliveries.claimWebhookDelivery, {
            bodyDigest: await sha256Hex(rawBody),
            deliveryId: delivery.deliveryId,
            triggerId: triggerId as Id<"triggers">,
        });

        return recordId === null
            ? null
            : {
                  args: { deliveryRecord: recordId },
                  giveBack: async () => {
                      await context.runMutation(internal.triggers.deliveries.releaseWebhookDelivery, { recordId });
                  },
              };
    }

    const claimKey = { key: `${triggerId}:${normalizeSignature(delivery.presented)}`, scope: "trigger-webhook" };
    const claimedAt = await context.runMutation(internal.lib.claim_once.claimKeyFenced, {
        ...claimKey,
        ttlMs: TRIGGER_CLAIM_TTL_MS,
        userId: trigger.userId,
    });

    if (claimedAt === null) {
        return null;
    }

    // Every release names the claim it took: a step that outlives the TTL must not clear a redelivery's replacement.
    const claim = { ...claimKey, claimedAt };

    return {
        args: { claim },
        giveBack: async () => {
            await context.runMutation(internal.lib.claim_once.releaseKey, claim);
        },
    };
};

/** Whether a header of a scheme OTHER than `scheme` is on the request. */
const carriesForeignHeader = (headers: Headers, scheme: WebhookSignatureScheme): boolean =>
    (Object.keys(SCHEMES) as WebhookSignatureScheme[]).some((other) => other !== scheme && SCHEMES[other].headers.some((name) => headers.has(name)));

/**
 * Read what the trigger's scheme expects. A request carrying another scheme's
 * headers is refused outright, so one scheme's credential is never tried as
 * another's. Every HMAC and token comparison is left to the scheme's `verify`.
 */
const readDelivery = (headers: Headers, body: Uint8Array, scheme: WebhookSignatureScheme): Delivery | { error: string } =>
    carriesForeignHeader(headers, scheme) ? { error: MISSING_SIGNATURE } : SCHEMES[scheme].read(headers, body);

/** `sha256=<hex>` or bare hex, lower-cased — also the dedupe key. */
const normalizeSignature = (signature: string): string => (signature.startsWith("sha256=") ? signature.slice(7) : signature).toLowerCase();

/**
 * Verify HMAC-SHA256 signature.
 * Supports both raw hex and "sha256=hex" format (GitHub-style).
 */
export const verifyHmacSignature = async (secret: string, payload: string | Uint8Array, signature: string): Promise<boolean> =>
    timingSafeEqual(await hmacSha256Hex(secret, payload), normalizeSignature(signature));

export default handleTriggerWebhook;
