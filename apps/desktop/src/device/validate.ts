/**
 * Type and size checks on what the page or the device window sends, before it
 * reaches the addon. The Rust core validates the content (signatures, pairing
 * format, root folders); these checks keep a malformed or oversized value out
 * of the native boundary and give a clear error for it.
 */

import type { HostSpec } from "./types";

/** Matches the backend's per-call input cap with room for the envelope. */
const MAX_ENVELOPE_BYTES = 256 * 1024;
const MAX_SIGNATURE_LENGTH = 64;
const MAX_SETTINGS_BYTES = 256 * 1024;
const LINE_BREAK = /[\n\r]/u;
const PROMPT_ANSWERS = new Set(["always", "deny", "once"]);
/** A key passphrase is a line of text; OpenSSH reads no more than this much of one. */
const MAX_SECRET_LENGTH = 1024;

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

const optionalText = (value: unknown, name: string, max: number): string | undefined => {
    if (["", null, undefined].includes(value as string | null | undefined)) {
        return undefined;
    }

    return text(value, name, max);
};

/**
 * Where to connect and how to log in. The Rust core validates the content (an address or user that could be read
 * as an ssh option, a key file that is not an absolute path); this keeps the wrong types and sizes out first.
 */
export const readHostSpec = (value: unknown): HostSpec => {
    if (!isRecord(value)) {
        throw new Error("device: server is invalid");
    }

    const port = value.port ?? 22;

    if (typeof port !== "number" || !Number.isSafeInteger(port) || port < 1 || port > 65_535) {
        throw new Error("device: port is invalid");
    }

    const identityFile = optionalText(value.identityFile, "identityFile", 1000);

    return {
        address: text(value.address, "address", 253),
        forwardAgent: value.forwardAgent === true,
        name: text(value.name, "name", 80),
        port,
        user: text(value.user, "user", 32),
        ...identityFile !== undefined && { identityFile },
    };
};

/** A server and the secret the backend minted for it; the core stores the secret only after a local click. */
export const readHostPairing = (value: unknown): { deviceId: string; secret: string; spec: HostSpec } => {
    if (!isRecord(value)) {
        throw new Error("device: pairing is invalid");
    }

    return { deviceId: text(value.deviceId, "deviceId", 64), secret: text(value.secret, "secret", 64), spec: readHostSpec(value.spec) };
};

export const readDeviceId = (value: unknown): string => text(value, "deviceId", 64);

/** The device a manifest is for: this computer's when absent. */
export const readOptionalDeviceId = (value: unknown): string | undefined => value === undefined ? undefined : text(value, "deviceId", 64);

/** What was typed for a passphrase prompt. Never logged, never part of an error. */
export const readSecretAnswer = (id: unknown, secret: unknown): { id: number; secret: string } => {
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1) {
        throw new Error("device: prompt id is invalid");
    }

    if (typeof secret !== "string" || secret.length === 0 || secret.length > MAX_SECRET_LENGTH || LINE_BREAK.test(secret)) {
        throw new Error("device: passphrase is invalid");
    }

    return { id, secret };
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
