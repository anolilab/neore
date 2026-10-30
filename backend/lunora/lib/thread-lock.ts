/**
 * Password-protected (locked) threads: the pure part.
 *
 * - The passcode is hashed with PBKDF2-SHA256 (WebCrypto, per-row random salt)
 *   and compared in constant time. The plaintext never reaches a row or a log.
 * - An unlock returns a short-lived PROOF: `{threadId}:{userId}:{expiresAt}:{hmac}`.
 *   The HMAC covers an `epoch` stored on the passcode row, so changing the
 *   passcode, locking again or removing the lock invalidates every proof minted
 *   before it.
 * - Admission (`agent/thread-read-access.ts`) is the choke point that checks a
 *   proof. Everything else here is data shaping.
 *
 * This is NOT end-to-end encryption. The operator can read the rows.
 */

import { LunoraError } from "lunorash/server";

import { base64ToBytes, bytesToBase64, hmacSha256Hex, timingSafeEqual } from "./crypto";

/** The code a refused locked-thread read carries in `error.data.code`. */
export const THREAD_LOCKED_CODE = "THREAD_LOCKED";

/**
 * Highest count the pinned workerd accepts without a `NotSupportedError`
 * (probed 2026-10: 1,000,000 passes). 600,000 is the OWASP guidance for
 * PBKDF2-HMAC-SHA256 and costs ~0.6 s of CPU per hash on workerd. The count is
 * stored per row, so it can be raised later without invalidating old passcodes.
 */
export const PASSCODE_PBKDF2_ITERATIONS = 600_000;

export const PASSCODE_MIN_LENGTH = 6;
export const PASSCODE_MAX_LENGTH = 200;

/** A proof is good for this long after it is minted. The client also forgets it when idle. */
export const UNLOCK_PROOF_TTL_MS = 30 * 60 * 1000;

/** What a locked row shows in place of its title. Clients translate it. */
export const LOCKED_THREAD_TITLE = "Locked chat";

const encoder = new TextEncoder();

const randomBytes = (length: number): Uint8Array<ArrayBuffer> => {
    const bytes = new Uint8Array(new ArrayBuffer(length));

    crypto.getRandomValues(bytes);

    return bytes;
};

/** A fresh epoch: rotated by every lock, unlock-changing and removal, so old proofs die. */
export const newPasscodeEpoch = (): string => bytesToBase64(randomBytes(16));

const derivePasscodeHash = async (passcode: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<string> => {
    const key = await crypto.subtle.importKey("raw", encoder.encode(passcode), "PBKDF2", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits({ hash: "SHA-256", iterations, name: "PBKDF2", salt }, key, 256);

    return bytesToBase64(new Uint8Array(bits));
};

export interface PasscodeHash {
    hash: string;
    iterations: number;
    salt: string;
}

/** Hashes a new passcode under a fresh random salt. */
export const hashPasscode = async (passcode: string, iterations: number = PASSCODE_PBKDF2_ITERATIONS): Promise<PasscodeHash> => {
    const salt = randomBytes(16);

    return {
        hash: await derivePasscodeHash(passcode, salt, iterations),
        iterations,
        salt: bytesToBase64(salt),
    };
};

/** Checks a passcode against a stored hash. Never throws for a wrong passcode. */
export const verifyPasscode = async (passcode: string, stored: PasscodeHash): Promise<boolean> => {
    const derived = await derivePasscodeHash(passcode, new Uint8Array(base64ToBytes(stored.salt)), stored.iterations);

    return timingSafeEqual(derived, stored.hash);
};

/** Length gate for a new passcode. The passcode is otherwise free-form. */
export const isAcceptablePasscode = (passcode: string): boolean => passcode.length >= PASSCODE_MIN_LENGTH && passcode.length <= PASSCODE_MAX_LENGTH;

const proofMessage = (threadId: string, userId: string, epoch: string, expiresAt: number): string =>
    `thread-unlock\n${threadId}\n${userId}\n${epoch}\n${expiresAt}`;

const assertDelimiterFree = (values: string[]): void => {
    for (const value of values) {
        if (value.includes(":")) {
            throw new Error("Unlock proof fields must not contain ':'");
        }
    }
};

export interface UnlockProofScope {
    epoch: string;
    threadId: string;
    userId: string;
}

/** Mints a proof for a passcode that was just verified. `secret` is the backend signing secret. */
export const mintUnlockProof = async (scope: UnlockProofScope, secret: string, now: number): Promise<{ expiresAt: number; proof: string }> => {
    assertDelimiterFree([scope.threadId, scope.userId]);

    if (secret === "") {
        throw new Error("Unlock proofs need a signing secret");
    }

    const expiresAt = now + UNLOCK_PROOF_TTL_MS;
    const hmac = await hmacSha256Hex(secret, proofMessage(scope.threadId, scope.userId, scope.epoch, expiresAt));

    return { expiresAt, proof: `${scope.threadId}:${scope.userId}:${expiresAt}:${hmac}` };
};

/**
 * True only for an unexpired proof minted for THIS thread, THIS user and the
 * CURRENT epoch. Returns false, never throws, for anything malformed.
 */
export const verifyUnlockProof = async (proof: string | null | undefined, scope: UnlockProofScope, secret: string, now: number): Promise<boolean> => {
    if (typeof proof !== "string" || secret === "") {
        return false;
    }

    const parts = proof.split(":");

    if (parts.length !== 4) {
        return false;
    }

    const [threadId, userId, expiresAtText, hmac] = parts as [string, string, string, string];
    const expiresAt = Number(expiresAtText);

    if (threadId !== scope.threadId || userId !== scope.userId || !Number.isFinite(expiresAt) || now > expiresAt) {
        return false;
    }

    const expected = await hmacSha256Hex(secret, proofMessage(threadId, userId, scope.epoch, expiresAt));

    return timingSafeEqual(hmac, expected);
};

/**
 * The fields a locked thread keeps when it is shown to its owner in a list.
 * The owner's unread/snooze state is metadata and stays. Everything that carries content or a credential is dropped: the title,
 * summary, tags, category, system prompt, project/org/team ids, the public
 * share token and the group settings.
 */
const LOCKED_STUB_KEYS = [
    "_creationTime",
    "_id",
    "awaitingInput",
    "createdAt",
    "deleted",
    "deletedAt",
    "lastReplyAt",
    "lastViewedAt",
    "lockedAt",
    "pinnedAt",
    "snoozedUntil",
    "status",
    "updatedAt",
] as const;

export type LockedThreadStub = Partial<Record<(typeof LOCKED_STUB_KEYS)[number], unknown>> & { _creationTime: number; _id: string; status: string };

export const isThreadLocked = (thread: { lockedAt?: number | null }): boolean => thread.lockedAt !== undefined && thread.lockedAt !== null;

/** The list view of a locked thread: metadata only, no content. */
export const toLockedThreadStub = <
    T extends Partial<Record<(typeof LOCKED_STUB_KEYS)[number], unknown>> & { _creationTime: number; _id: string; status: string },
>(
    thread: T,
): LockedThreadStub => {
    const stub: Record<string, unknown> = {};

    for (const key of LOCKED_STUB_KEYS) {
        if (thread[key] !== undefined && thread[key] !== null) {
            stub[key] = thread[key];
        }
    }

    return stub as LockedThreadStub;
};

/** Refusal for a content read with no valid proof. The client reads `data.code` and opens the unlock dialog. */
export const throwThreadLocked: () => never = () => {
    throw new LunoraError("FORBIDDEN", "This chat is locked.", { data: { code: THREAD_LOCKED_CODE } });
};
