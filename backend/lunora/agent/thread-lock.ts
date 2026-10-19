/**
 * Locking a thread with a passcode: set, unlock, change, lock again, remove.
 *
 * Every procedure here is OWNER-only and uses `requireOwnedThreadIgnoringLock`,
 * because these are exactly the calls that must work on a locked thread without
 * its proof. A wrong passcode is a RESULT (`ok: false`), not a thrown error, so
 * the failure count it writes commits. Throwing would roll it back and let
 * guessing run unthrottled.
 */

import { LunoraError, v } from "lunorash/server";

import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { authMutation, rateLimit } from "../lib/crpc";
import { throwThreadNotFound } from "../lib/error-helpers";
import { patchRow } from "../lib/patch";
import { hashPasscode, isAcceptablePasscode, isThreadLocked, mintUnlockProof, newPasscodeEpoch, PASSCODE_MAX_LENGTH, verifyPasscode } from "../lib/thread-lock";

import { passcodeHashOf, readPasscodeRow, type PasscodeRow, unlockSecret } from "./thread-passcode";
import { requireOwnedThreadIgnoringLock } from "./thread-read-access";

const vPasscode = v.string().max(PASSCODE_MAX_LENGTH);

const vLockResult = v.object({
    expiresAt: v.optional(v.number()),
    ok: v.boolean(),
    proof: v.optional(v.string()),
    retryAfterMs: v.optional(v.number()),
});

/**
 * Failed attempts are free up to 4, then the wait doubles from 30 s, capped at 1 h.
 * Lives on the passcode row, so it is per user and per thread.
 */
export const backoffMs = (failedAttempts: number): number => (failedAttempts < 5 ? 0 : Math.min(30_000 * 2 ** (failedAttempts - 5), 60 * 60_000));

/** Verifies a passcode against the row and records the attempt. Writes, returns the verdict. */
export const checkPasscode = async (context: MutationCtx, row: PasscodeRow, passcode: string, now: number): Promise<{ ok: boolean; retryAfterMs?: number }> => {
    if (row.lockoutUntil !== undefined && row.lockoutUntil > now) {
        return { ok: false, retryAfterMs: row.lockoutUntil - now };
    }

    if (await verifyPasscode(passcode, passcodeHashOf(row))) {
        if (row.failedAttempts !== 0 || row.lockoutUntil !== undefined) {
            await patchRow(context.db, row, { failedAttempts: 0, lockoutUntil: undefined });
        }

        return { ok: true };
    }

    const failedAttempts = row.failedAttempts + 1;
    const wait = backoffMs(failedAttempts);

    await patchRow(context.db, row, { failedAttempts, lockoutUntil: wait > 0 ? now + wait : undefined });

    return { ok: false, retryAfterMs: wait > 0 ? wait : undefined };
};

const requireLockedRow = async (context: MutationCtx, threadId: Id<"threads">) => {
    const row = await readPasscodeRow(context.db, threadId);

    if (!row) {
        return throwThreadNotFound();
    }

    return row;
};

export const enableThreadLock = authMutation
    .use(rateLimit("threadLock/unlock"))
    .input({
        passcode: vPasscode,
        threadId: v.id("threads"),
    })
    .output(vLockResult)
    .mutation(async ({ args: { passcode, threadId }, ctx: context }) => {
        const { userId } = context.user;
        const { now } = context;

        if (!isAcceptablePasscode(passcode)) {
            throw new LunoraError("BAD_REQUEST", "The passcode must be between 6 and 200 characters.");
        }

        const thread = await requireOwnedThreadIgnoringLock(context, threadId, userId);

        if (thread.deleted === true) {
            return throwThreadNotFound();
        }

        if (isThreadLocked(thread)) {
            throw new LunoraError("CONFLICT", "This chat is already locked.");
        }

        if (thread.isPublic === true) {
            throw new LunoraError("BAD_REQUEST", "Stop sharing this chat before you lock it.");
        }

        const grant = await context.db.threadAccess.findFirst({ where: { threadId } });

        if (grant) {
            throw new LunoraError("BAD_REQUEST", "Remove shared access before you lock this chat.");
        }

        const epoch = newPasscodeEpoch();
        const { hash, iterations, salt } = await hashPasscode(passcode);

        await context.db.insert("threadPasscodes", {
            createdAt: now,
            epoch,
            failedAttempts: 0,
            hash,
            iterations,
            salt,
            threadId,
            updatedAt: now,
            userId,
        });
        await patchRow(context.db, thread, { lockedAt: now, updatedAt: now });

        const { expiresAt, proof } = await mintUnlockProof({ epoch, threadId, userId }, unlockSecret(), now);

        return { expiresAt, ok: true, proof };
    });

export const unlockThread = authMutation
    .use(rateLimit("threadLock/unlock"))
    .input({
        passcode: vPasscode,
        threadId: v.id("threads"),
    })
    .output(vLockResult)
    .mutation(async ({ args: { passcode, threadId }, ctx: context }) => {
        const { userId } = context.user;
        const { now } = context;
        const thread = await requireOwnedThreadIgnoringLock(context, threadId, userId);

        if (!isThreadLocked(thread)) {
            return { ok: true };
        }

        const row = await requireLockedRow(context, threadId);
        const verdict = await checkPasscode(context, row, passcode, now);

        if (!verdict.ok) {
            return { ok: false, retryAfterMs: verdict.retryAfterMs };
        }

        const { expiresAt, proof } = await mintUnlockProof({ epoch: row.epoch, threadId, userId }, unlockSecret(), now);

        return { expiresAt, ok: true, proof };
    });

/** "Lock now": rotates the epoch, so every proof minted so far stops working. */
export const lockThread = authMutation
    .use(rateLimit("threadLock/unlock"))
    .input({ threadId: v.id("threads") })
    .output(vLockResult)
    .mutation(async ({ args: { threadId }, ctx: context }) => {
        const { userId } = context.user;
        const { now } = context;
        const thread = await requireOwnedThreadIgnoringLock(context, threadId, userId);

        if (!isThreadLocked(thread)) {
            return { ok: true };
        }

        const row = await requireLockedRow(context, threadId);

        await patchRow(context.db, row, { epoch: newPasscodeEpoch(), updatedAt: now });
        await patchRow(context.db, thread, { updatedAt: now });

        return { ok: true };
    });

export const changeThreadPasscode = authMutation
    .use(rateLimit("threadLock/unlock"))
    .input({
        currentPasscode: vPasscode,
        newPasscode: vPasscode,
        threadId: v.id("threads"),
    })
    .output(vLockResult)
    .mutation(async ({ args: { currentPasscode, newPasscode, threadId }, ctx: context }) => {
        const { userId } = context.user;
        const { now } = context;
        const thread = await requireOwnedThreadIgnoringLock(context, threadId, userId);

        if (!isThreadLocked(thread)) {
            throw new LunoraError("BAD_REQUEST", "This chat has no passcode to change.");
        }

        if (!isAcceptablePasscode(newPasscode)) {
            throw new LunoraError("BAD_REQUEST", "The passcode must be between 6 and 200 characters.");
        }

        const row = await requireLockedRow(context, threadId);
        const verdict = await checkPasscode(context, row, currentPasscode, now);

        if (!verdict.ok) {
            return { ok: false, retryAfterMs: verdict.retryAfterMs };
        }

        // A new salt AND a new epoch: the old hash and every proof minted under it are dead.
        const epoch = newPasscodeEpoch();
        const { hash, iterations, salt } = await hashPasscode(newPasscode);

        await patchRow(context.db, row, { epoch, failedAttempts: 0, hash, iterations, lockoutUntil: undefined, salt, updatedAt: now });
        await patchRow(context.db, thread, { updatedAt: now });

        const { expiresAt, proof } = await mintUnlockProof({ epoch, threadId, userId }, unlockSecret(), now);

        return { expiresAt, ok: true, proof };
    });

/** Removes the passcode. Needs the passcode itself, so a live session alone cannot strip the lock. */
export const removeThreadPasscode = authMutation
    .use(rateLimit("threadLock/unlock"))
    .input({
        passcode: vPasscode,
        threadId: v.id("threads"),
    })
    .output(vLockResult)
    .mutation(async ({ args: { passcode, threadId }, ctx: context }) => {
        const { userId } = context.user;
        const { now } = context;
        const thread = await requireOwnedThreadIgnoringLock(context, threadId, userId);

        if (!isThreadLocked(thread)) {
            return { ok: true };
        }

        const row = await requireLockedRow(context, threadId);
        const verdict = await checkPasscode(context, row, passcode, now);

        if (!verdict.ok) {
            return { ok: false, retryAfterMs: verdict.retryAfterMs };
        }

        await context.db.delete(row._id);
        await patchRow(context.db, thread, { lockedAt: undefined, updatedAt: now });

        return { ok: true };
    });
