/**
 * Resend delivery-event webhook.
 *
 * The Resend component verified and dispatched this for us
 * (`resend.handleResendEventWebhook`). Resend signs with Svix, so replacing the
 * component means implementing Svix verification — it is short, but getting it
 * wrong means an unauthenticated endpoint that can delete rows from `emails`.
 *
 * Svix signs `{id}.{timestamp}.{body}` with HMAC-SHA256 under a base64 secret
 * carrying a `whsec_` prefix, and sends the result as a space-separated list of
 * `v1,<base64>` entries (several appear during secret rotation, so ANY match is
 * a pass).
 */
import type { HttpActionCtx } from "lunorash/server";

import { internal } from "../_generated/internal";
import { RESEND_WEBHOOK_SECRET } from "../env";
import { base64ToBytes, bytesToBase64, hmacSha256, isWithinWindow, SIGNED_REQUEST_WINDOW_MS, timingSafeEqual } from "../lib/crypto";
import { emailLogger } from "../lib/logger";

const verify = async (request: Request, body: string): Promise<boolean> => {
    const id = request.headers.get("svix-id");
    const timestamp = request.headers.get("svix-timestamp");
    const signatures = request.headers.get("svix-signature");

    if (!id || !timestamp || !signatures || !RESEND_WEBHOOK_SECRET) {
        return false;
    }

    if (!isWithinWindow(Number(timestamp) * 1000, SIGNED_REQUEST_WINDOW_MS)) {
        return false;
    }

    const secret = RESEND_WEBHOOK_SECRET.startsWith("whsec_") ? RESEND_WEBHOOK_SECRET.slice(6) : RESEND_WEBHOOK_SECRET;
    const expected = bytesToBase64(await hmacSha256(base64ToBytes(secret), `${id}.${timestamp}.${body}`));

    // Rotation puts several `v1,<sig>` entries in the header; any match passes.
    return signatures
        .split(" ")
        .map((entry) => entry.split(",", 2)[1] ?? "")
        .some((candidate) => timingSafeEqual(candidate, expected));
};

export const handleResendWebhook = async (context: HttpActionCtx, request: Request): Promise<Response> => {
    if (!RESEND_WEBHOOK_SECRET) {
        return Response.json({ error: "Email service not configured" }, { status: 503 });
    }

    const body = await request.text();

    if (!(await verify(request, body))) {
        emailLogger.warn("Rejected Resend webhook with an invalid signature");

        return Response.json({ error: "Invalid signature" }, { status: 401 });
    }

    const payload = JSON.parse(body) as { data?: { email_id?: string }; type?: string };

    if (!payload.type || !payload.data?.email_id) {
        return Response.json({ error: "Malformed payload" }, { status: 400 });
    }

    await context.runMutation(internal.email.functions.handleEmailEvent, {
        event: { type: payload.type },
        id: payload.data.email_id,
    });

    return Response.json({ ok: true });
};

export default handleResendWebhook;
