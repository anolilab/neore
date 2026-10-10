/**
 * The device wire format. Everything that crosses the page between the backend
 * and the native shell's Rust core is a JSON `payload` STRING plus
 * `signature = hex(HMAC-SHA256(secret, DOMAIN + payload))`.
 *
 * Signing the exact string (rather than a re-serialised object) means neither
 * side needs canonical JSON: the verifier checks the bytes it received and only
 * then parses them. The domain prefix keeps a signed result from being replayed
 * as a call, a manifest or a progress report. The Rust half is `apps/native/src-tauri/src/device/envelope.rs`;
 * `signing.test.ts` pins a vector both sides share.
 *
 * The secret is 32 random bytes as 64 hex characters, used as the HMAC key in
 * that ASCII form on both sides.
 */
import { bytesToHex, hmacSha256Hex, timingSafeEqual } from "../../lib/crypto";

export type DeviceSigningDomain = "call" | "manifest" | "progress" | "result";

const HEX_64 = /^[0-9a-f]{64}$/u;

const domainPrefix = (domain: DeviceSigningDomain): string => `neore-device:${domain}:v1\n`;

export const generateDeviceSecret = (): string => bytesToHex(crypto.getRandomValues(new Uint8Array(32)));

export const isDeviceSecret = (value: string): boolean => HEX_64.test(value);

export const signDevicePayload = async (secret: string, domain: DeviceSigningDomain, payload: string): Promise<string> =>
    await hmacSha256Hex(secret, domainPrefix(domain) + payload);

export const verifyDevicePayload = async (secret: string, domain: DeviceSigningDomain, payload: string, signature: string): Promise<boolean> => {
    if (!HEX_64.test(signature)) {
        return false;
    }

    return timingSafeEqual(await signDevicePayload(secret, domain, payload), signature);
};

/**
 * Parses a verified payload and checks it names the expected kind and device.
 * `null` for anything else — the caller answers with one generic refusal.
 */
export const parseSignedPayload = (payload: string, kind: DeviceSigningDomain, deviceId: string): Record<string, unknown> | null => {
    let parsed: unknown;

    try {
        parsed = JSON.parse(payload);
    } catch {
        return null;
    }

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return null;
    }

    const record = parsed as Record<string, unknown>;

    return record.v === 1 && record.kind === kind && record.deviceId === deviceId ? record : null;
};

/** Whether a device-stamped time is within `windowMs` of `now`, either side (clock skew). */
export const isFreshTimestamp = (value: unknown, now: number, windowMs: number): value is number =>
    typeof value === "number" && Number.isFinite(value) && Math.abs(now - value) <= windowMs;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Caps text at `maxBytes` of UTF-8 without splitting a character. The device
 * caps too; this is the backend's own, which never trusts the device's count.
 */
export const capUtf8 = (text: string, maxBytes: number): { text: string; truncated: boolean } => {
    const bytes = encoder.encode(text);

    if (bytes.length <= maxBytes) {
        return { text, truncated: false };
    }

    let end = maxBytes;

    // Back off continuation bytes (10xxxxxx) so the cut lands on a boundary.
    while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) {
        end -= 1;
    }

    return { text: decoder.decode(bytes.subarray(0, end)), truncated: true };
};

export const utf8Length = (text: string): number => encoder.encode(text).length;
