/**
 * The Events cursor: opaque to the client, and bound to one user.
 *
 * Shape: `<base64url({"s": seq, "u": userId})>.<hex HMAC-SHA256>`. The MAC covers the encoded payload under a purpose
 * label, keyed by `BETTER_AUTH_SECRET` (required by env validation). So a cursor another user holds, or one edited in any
 * byte, fails to verify and reads as `null`, which the caller answers with `InvalidParams`.
 *
 * Rotating `BETTER_AUTH_SECRET` invalidates every cursor. A client holding one then gets `InvalidParams` and starts again
 * with `cursor: null`, which the spec allows.
 */
import { bytesToBase64, hmacSha256Hex, timingSafeEqual } from "../lib/crypto";

const PURPOSE = "neore:mcp-events-cursor:v1";

const base64Url = (text: string): string => bytesToBase64(new TextEncoder().encode(text)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");

const fromBase64Url = (value: string): string | null => {
    try {
        const padded = value
            .replaceAll("-", "+")
            .replaceAll("_", "/")
            .padEnd(Math.ceil(value.length / 4) * 4, "=");

        return new TextDecoder().decode(Uint8Array.from(atob(padded), (char) => char.codePointAt(0)!));
    } catch {
        return null;
    }
};

const macOf = async (secret: string, payload: string): Promise<string> => await hmacSha256Hex(secret, `${PURPOSE}.${payload}`);

/** The cursor that resumes after event `seq` of `userId`'s log. */
export const encodeEventCursor = async (secret: string, userId: string, seq: number): Promise<string> => {
    const payload = base64Url(JSON.stringify({ s: seq, u: userId }));

    return `${payload}.${await macOf(secret, payload)}`;
};

/**
 * The position a cursor names for `userId`, or `null` when it is not one this user was given: malformed, edited, or another
 * user's. The MAC is checked before anything in the payload is read.
 */
export const decodeEventCursor = async (secret: string, userId: string, cursor: string): Promise<number | null> => {
    const dot = cursor.lastIndexOf(".");

    if (dot <= 0 || dot === cursor.length - 1) {
        return null;
    }

    const payload = cursor.slice(0, dot);
    const mac = cursor.slice(dot + 1);

    if (!timingSafeEqual(mac, await macOf(secret, payload))) {
        return null;
    }

    const json = fromBase64Url(payload);

    if (json === null) {
        return null;
    }

    let decoded: unknown;

    try {
        decoded = JSON.parse(json);
    } catch {
        return null;
    }

    if (!decoded || typeof decoded !== "object") {
        return null;
    }

    const { s, u } = decoded as { s?: unknown; u?: unknown };

    if (u !== userId || typeof s !== "number" || !Number.isSafeInteger(s) || s < 0) {
        return null;
    }

    return s;
};
