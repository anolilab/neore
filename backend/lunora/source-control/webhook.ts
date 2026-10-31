/**
 * A watched repository's webhook: `POST /source-control/webhook/{watchId}`.
 *
 * The host signs the raw body with the repository's secret (`X-Hub-Signature-256`, the trigger webhooks' `native`
 * scheme, which the driver declares in `webhookScheme`; a driver that declares none has no such route). A verified delivery does ONE thing: mark that repository dirty so the next shard tick polls it. The body
 * is never parsed and no header but the signature is read, so nothing a sender can write (a repository name, a pull
 * request number, a "review requested" event) reaches the cache, a notification or a host call; the repository is
 * the one the URL's row names, and what changed is read from the host with the user's own token.
 *
 * The scheme carries no timestamp, so a captured delivery can be replayed. That is harmless here by construction,
 * since all a replay does is mark dirty, and each signature is claimed once for `TRIGGER_CLAIM_TTL_MS` anyway
 * (`acceptWatchDelivery`). The unsigned delivery-id header is not trusted for the claim, as in `triggers/http.ts`.
 *
 * Every refusal before the signature is proven answers a bare 404 or 401, so a caller learns nothing about a row.
 */
import type { HttpActionCtx } from "lunorash/server";

import { internal } from "../_generated/internal";
import type { Id } from "../_generated/dataModel";
import { decryptKey } from "../lib/encryption";
import { checkRateLimit } from "../lib/rate-limiter";
import { MAX_WEBHOOK_BODY_BYTES } from "../triggers/filters";
import { verifyHmacSignature } from "../triggers/http";
import { DEVELOP_DRIVER } from "./develop-driver";

/** `X-Hub-Signature-256` is always `sha256=<64 hex>`; anything else is refused before any HMAC work. */
const NATIVE_SIGNATURE = /^sha256=[\da-f]{64}$/iu;

const reply = (status: number, body: Record<string, unknown>): Response => Response.json(body, { headers: { "Content-Type": "application/json" }, status });

const notFound = (): Response => reply(404, { error: "Not found" });

export const handleWatchWebhook = async (context: HttpActionCtx, request: Request, watchId: string): Promise<Response> => {
    // Only the scheme the driver declares is verified; a host without one has no webhook route.
    if (DEVELOP_DRIVER.webhookScheme !== "native") {
        return notFound();
    }

    try {
        let watch: { webhookSecret: string } | null;

        try {
            watch = await context.runQuery(internal.source_control.freshness_internal.getWatchForWebhook, { watchId: watchId as Id<"watchedRepositories"> });
        } catch {
            // An id that is not one throws: the same answer as an unknown row.
            return notFound();
        }

        if (watch === null) {
            return notFound();
        }

        const declared = request.headers.get("content-length");

        if (declared && Number.parseInt(declared, 10) > MAX_WEBHOOK_BODY_BYTES) {
            return reply(413, { error: "Payload too large" });
        }

        // The signature covers the bytes the sender sent: verified over those, not over decoded text.
        const rawBody = new Uint8Array(await request.arrayBuffer());

        if (rawBody.byteLength > MAX_WEBHOOK_BODY_BYTES) {
            return reply(413, { error: "Payload too large" });
        }

        const signature = request.headers.get("x-hub-signature-256");

        if (signature === null || !NATIVE_SIGNATURE.test(signature)) {
            return reply(401, { error: "Missing or invalid signature headers" });
        }

        const secret = await decryptKey(watch.webhookSecret, "tool-keys");

        if (!(await verifyHmacSignature(secret, rawBody, signature))) {
            return reply(401, { error: "Invalid signature" });
        }

        // Charged only once the sender is proven, or anyone who knew the id could spend the owner's quota with junk.
        const limited = await checkRateLimit(context, "sourceControl/webhook", { failMode: "open", key: watchId, throws: false });

        if (!limited.ok) {
            return reply(429, { error: "Too many requests" });
        }

        const outcome = await context.runMutation(internal.source_control.freshness_internal.acceptWatchDelivery, {
            signature: signature.slice("sha256=".length).toLowerCase(),
            watchId: watchId as Id<"watchedRepositories">,
        });

        if (outcome === "not_found") {
            return notFound();
        }

        return outcome === "duplicate" ? reply(200, { duplicate: true, ok: true }) : reply(202, { ok: true });
    } catch (error) {
        console.error(`[Develop] Webhook handler error for ${watchId}:`, error);

        return reply(500, { error: "Internal server error" });
    }
};
