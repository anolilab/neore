/**
 * VAPID keys for Web Push. OPTIONAL: with either key unset push is off — no
 * subscribe button in settings, no send job scheduled — and the in-app inbox
 * works as before. `scripts/dev-setup.js` generates a pair for local dev.
 */
import type { WebPushConfig } from "@lunora/notify";
import { webPushFromEnv } from "@lunora/notify";

/** Contact the push services may reach the sender at (RFC 8292 `sub`). */
const DEFAULT_SUBJECT = "mailto:support@neore.chat";

/** A push service keeps an undelivered message this long (seconds); the package default is 28 days. */
const PUSH_TTL_SECONDS = 24 * 60 * 60;

const read = (env: Record<string, unknown>, key: string): string => {
    const value = env[key];

    return typeof value === "string" ? value.trim() : "";
};

/**
 * The Web Push channel config, or `undefined` when the key pair is missing.
 * `webPushFromEnv` also leaves the channel off without a subject; a missing or
 * malformed one falls back to the support address instead.
 */
export const webPushConfig = (env: Record<string, unknown>): WebPushConfig | undefined => {
    const subject = read(env, "VAPID_SUBJECT");

    return webPushFromEnv(
        {
            VAPID_PRIVATE_KEY: read(env, "VAPID_PRIVATE_KEY"),
            VAPID_PUBLIC_KEY: read(env, "VAPID_PUBLIC_KEY"),
            VAPID_SUBJECT: subject.startsWith("mailto:") || subject.startsWith("https:") ? subject : DEFAULT_SUBJECT,
        },
        { ttl: PUSH_TTL_SECONDS },
    );
};

export const isPushConfigured = (): boolean => webPushConfig(process.env) !== undefined;
