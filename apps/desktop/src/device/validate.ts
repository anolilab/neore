/**
 * Type and size checks on what the page or the device window sends, before it
 * reaches the addon. The Rust core validates the content (signatures, pairing
 * format, root folders); these checks keep a malformed or oversized value out
 * of the native boundary and give a clear error for it.
 */

/** Matches the backend's per-call input cap with room for the envelope. */
const MAX_ENVELOPE_BYTES = 256 * 1024;
const MAX_SIGNATURE_LENGTH = 64;
const MAX_SETTINGS_BYTES = 256 * 1024;
const PROMPT_ANSWERS = new Set(["always", "deny", "once"]);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown, name: string, max: number): string => {
    if (typeof value !== "string" || value.length === 0 || value.length > max) {
        throw new Error(`device: ${name} is invalid`);
    }

    return value;
};

export const readPairing = (value: unknown): { accountLabel: string; deviceId: string; secret: string } => {
    if (!isRecord(value)) {
        throw new Error("device: pairing is invalid");
    }

    return {
        // Passed through unchanged: the core rejects an over-long label, it does not cut it.
        accountLabel: typeof value.accountLabel === "string" && value.accountLabel.length <= 1000 ? value.accountLabel : "",
        deviceId: text(value.deviceId, "deviceId", 64),
        secret: text(value.secret, "secret", 64),
    };
};

export const readSigned = (value: unknown): { envelope: string; signature: string } => {
    if (!isRecord(value)) {
        throw new Error("device: call is invalid");
    }

    const envelope = text(value.envelope, "envelope", MAX_ENVELOPE_BYTES);
    const signature = text(value.signature, "signature", MAX_SIGNATURE_LENGTH);

    return { envelope, signature };
};

export const readSettingsUpdate = (value: unknown): string => {
    if (!isRecord(value)) {
        throw new Error("device: settings update is invalid");
    }

    const json = JSON.stringify(value);

    if (json.length > MAX_SETTINGS_BYTES) {
        throw new Error("device: settings update is too large");
    }

    return json;
};

export const readPromptAnswer = (id: unknown, answer: unknown): { answer: string; id: number } => {
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1) {
        throw new Error("device: prompt id is invalid");
    }

    if (typeof answer !== "string" || !PROMPT_ANSWERS.has(answer)) {
        throw new Error("device: answer is invalid");
    }

    return { answer, id };
};

const MAX_PROMPT_CHARS = 100_000;
const MAX_PATH_CHARS = 4096;

export const readAcpUpdate = (value: unknown): string => {
    if (!isRecord(value)) {
        throw new Error("device: agent update is invalid");
    }

    // A variable's value is in here: nothing quotes it back in an error.
    const json = JSON.stringify(value);

    if (json.length > MAX_SETTINGS_BYTES) {
        throw new Error("device: agent update is too large");
    }

    return json;
};

export const readAgentKey = (value: unknown): string => text(value, "agent", 40);

export const readSessionId = (value: unknown): string => text(value, "session", 64);

export const readFolder = (value: unknown): string => text(value, "folder", MAX_PATH_CHARS);

export const readPrompt = (value: unknown): string => text(value, "prompt", MAX_PROMPT_CHARS);
