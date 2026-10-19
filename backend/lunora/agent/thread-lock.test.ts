/**
 * The passcode lock at its choke points, driven against the real schema:
 * admission (`resolveThreadReadAccess`), the helper that content reads use
 * (`requireThreadPermission`), and the reply edit (`editAssistantReplyHandler`).
 */
import { lunoraTest } from "@lunora/testing";
import { beforeEach, describe, expect, it } from "vitest";

import schema from "../schema";
import { THREAD_LOCKED_CODE, UNLOCK_PROOF_TTL_MS, hashPasscode, mintUnlockProof, newPasscodeEpoch } from "../lib/thread-lock";
import { backoffMs, checkPasscode } from "./thread-lock";
import { readPasscodeRow } from "./thread-passcode";
import { editAssistantReplyHandler } from "./branches";
import { resolveThreadReadAccess, requireThreadPermission } from "./thread-read-access";

const OWNER = "owner-user";
const STRANGER = "stranger-user";
const SECRET = "p".repeat(40);

type Harness = ReturnType<typeof lunoraTest>;
let harness: Harness;
let threadId: string;
let epoch: string;

const lockedCode = (error: unknown) => (error as { data?: { code?: string } } | null)?.data?.code;

const proofFor = async (userId: string, at = Date.now()) => {
    const { proof } = await mintUnlockProof({ epoch, threadId, userId }, SECRET, at);

    return proof;
};

const resolve = (userId: string, proof?: string) => harness.run(async (ctx: any) => await resolveThreadReadAccess(ctx, threadId as never, userId, proof));

beforeEach(async () => {
    process.env.STORAGE_SIGNING_SECRET = SECRET;
    harness = lunoraTest(schema as never);
    epoch = newPasscodeEpoch();
    const hashed = await hashPasscode("passcode-1", 1000);

    threadId = await harness.run(
        async (ctx: any) => await ctx.db.insert("threads", { lockedAt: Date.now(), status: "active", title: "Salary plan", userId: OWNER }),
    );
    await harness.run(
        async (ctx: any) =>
            await ctx.db.insert("threadPasscodes", {
                createdAt: 1,
                epoch,
                failedAttempts: 0,
                hash: hashed.hash,
                iterations: hashed.iterations,
                salt: hashed.salt,
                threadId,
                updatedAt: 1,
                userId: OWNER,
            }),
    );
});

describe("admission on a locked thread", () => {
    it("returns the locked outcome to the owner with no proof", async () => {
        expect(await resolve(OWNER)).toMatchObject({ kind: "locked" });
    });

    it("admits the owner with a live proof", async () => {
        expect(await resolve(OWNER, await proofFor(OWNER))).toMatchObject({ kind: "full" });
    });

    it("refuses an expired proof", async () => {
        const stale = await proofFor(OWNER, Date.now() - UNLOCK_PROOF_TTL_MS - 60_000);

        expect(await resolve(OWNER, stale)).toMatchObject({ kind: "locked" });
    });

    it("refuses a proof from an older epoch after the lock is re-set", async () => {
        const old = await proofFor(OWNER);

        epoch = newPasscodeEpoch();
        await harness.run(async (ctx: any) => {
            const row = await ctx.db
                .query("threadPasscodes")
                .withIndex("by_thread", (q: any) => q.eq("threadId", threadId))
                .first();

            await ctx.db.patch(row._id, { epoch });
        });

        expect(await resolve(OWNER, old)).toMatchObject({ kind: "locked" });
    });

    it("gives a stranger nothing, even with a proof for another user", async () => {
        expect(await resolve(STRANGER, await proofFor(STRANGER))).toBeNull();
        expect(await resolve(STRANGER)).toBeNull();
    });

    it("refuses a content helper with THREAD_LOCKED and admits it with a proof", async () => {
        await expect(harness.run(async (ctx: any) => await requireThreadPermission(ctx, threadId as never, OWNER, "read"))).rejects.toMatchObject({
            data: { code: THREAD_LOCKED_CODE },
        });

        const admitted = await harness.run(async (ctx: any) => await requireThreadPermission(ctx, threadId as never, OWNER, "read", await proofFor(OWNER)));

        expect(admitted.permission).toBe("admin");
    });
});

describe("editing a reply in a locked thread", () => {
    const edit = (unlockProof?: string) =>
        harness.run(
            async (ctx: any) =>
                await editAssistantReplyHandler(ctx, { messageId: "m1", text: "changed", threadId: threadId as never, unlockProof, userId: OWNER }),
        );

    it("refuses without a proof", async () => {
        await expect(edit()).rejects.toMatchObject({ data: { code: THREAD_LOCKED_CODE } });
    });

    it("refuses with an expired proof", async () => {
        await expect(edit(await proofFor(OWNER, Date.now() - UNLOCK_PROOF_TTL_MS - 60_000))).rejects.toMatchObject({ data: { code: THREAD_LOCKED_CODE } });
    });

    it("refuses with a proof from an older epoch", async () => {
        const old = await proofFor(OWNER);

        await harness.run(async (ctx: any) => {
            const row = await ctx.db
                .query("threadPasscodes")
                .withIndex("by_thread", (q: any) => q.eq("threadId", threadId))
                .first();

            await ctx.db.patch(row._id, { epoch: newPasscodeEpoch() });
        });

        await expect(edit(old)).rejects.toMatchObject({ data: { code: THREAD_LOCKED_CODE } });
    });

    it("gets past the lock with a live proof (the failure is then the message, not the lock)", async () => {
        const error = await edit(await proofFor(OWNER)).catch((error_: unknown) => error_);

        expect(error).toBeInstanceOf(Error);
        expect(lockedCode(error)).not.toBe(THREAD_LOCKED_CODE);
    });
});

describe("wrong passcodes are counted per chat", () => {
    const NOW_ATTEMPT = 1_800_000_000_000;
    const attempt = (passcode: string, now: number) =>
        harness.run(async (ctx: any) => {
            const row = await readPasscodeRow(ctx.db, threadId as never);

            if (!row) {
                throw new Error("no passcode row");
            }

            return await checkPasscode(ctx, row, passcode, now);
        });
    const row = () => harness.run(async (ctx: any) => await readPasscodeRow(ctx.db, threadId as never));

    it("four wrong attempts set no lockout", async () => {
        for (let index = 0; index < 4; index += 1) {
            expect(await attempt("wrong-one", NOW_ATTEMPT)).toEqual({ ok: false, retryAfterMs: undefined });
        }

        const current = await row();

        expect(current?.failedAttempts).toBe(4);
        expect(current?.lockoutUntil).toBeUndefined();
    });

    it("the fifth wrong attempt locks the chat for 30 seconds", async () => {
        for (let index = 0; index < 5; index += 1) {
            await attempt("wrong-one", NOW_ATTEMPT);
        }

        const current = await row();

        expect(current?.failedAttempts).toBe(5);
        expect(current?.lockoutUntil).toBe(NOW_ATTEMPT + 30_000);
    });

    it("during a lockout even the right passcode is refused and the count does not move", async () => {
        for (let index = 0; index < 5; index += 1) {
            await attempt("wrong-one", NOW_ATTEMPT);
        }

        expect(await attempt("passcode-1", NOW_ATTEMPT + 10_000)).toEqual({ ok: false, retryAfterMs: 20_000 });

        const current = await row();

        expect(current?.failedAttempts).toBe(5);
    });

    it("the right passcode after the lockout resets the count", async () => {
        for (let index = 0; index < 5; index += 1) {
            await attempt("wrong-one", NOW_ATTEMPT);
        }

        expect(await attempt("passcode-1", NOW_ATTEMPT + 31_000)).toEqual({ ok: true });

        const current = await row();

        expect(current?.failedAttempts).toBe(0);
        expect(current?.lockoutUntil).toBeUndefined();
    });

    it("the wait doubles from the fifth failure and is capped at an hour", () => {
        expect([1, 4].map((count) => backoffMs(count))).toEqual([0, 0]);
        expect([5, 6, 7].map((count) => backoffMs(count))).toEqual([30_000, 60_000, 120_000]);
        expect(backoffMs(40)).toBe(60 * 60_000);
    });
});
