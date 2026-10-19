/**
 * A branch of a locked chat is locked: it takes the parent's passcode under its
 * own epoch, so the branch needs its own unlock. Each positive case has a
 * negative twin (no proof, or the parent's proof, is refused).
 */
import { lunoraTest } from "@lunora/testing";
import { beforeEach, describe, expect, it } from "vitest";

import schema from "../schema";
import { hashPasscode, mintUnlockProof, newPasscodeEpoch, verifyPasscode } from "../lib/thread-lock";
import { dropPasscodeRowsHandler, inheritPasscodeHandler } from "./thread-lock";
import { readPasscodeRow, isUnlockProofValid } from "./thread-passcode";
import { resolveThreadReadAccess } from "./thread-read-access";

const OWNER = "owner-user";
const SECRET = "b".repeat(40);
const PASSCODE = "passcode-1";
const MISSING_PASSCODE = /passcode is missing/u;

type Harness = ReturnType<typeof lunoraTest>;
let harness: Harness;
let parentId: string;
let branchId: string;
let parentEpoch: string;
let parentProof: string;

beforeEach(async () => {
    process.env.STORAGE_SIGNING_SECRET = SECRET;
    harness = lunoraTest(schema as never);
    parentEpoch = newPasscodeEpoch();
    const hashed = await hashPasscode(PASSCODE, 1000);

    parentId = await harness.run(async (ctx: any) => {
        const id = await ctx.db.insert("threads", { lockedAt: 1, status: "active", title: "Salary plan", userId: OWNER });

        await ctx.db.insert("threadPasscodes", {
            createdAt: 1,
            epoch: parentEpoch,
            failedAttempts: 0,
            hash: hashed.hash,
            iterations: hashed.iterations,
            salt: hashed.salt,
            threadId: id,
            updatedAt: 1,
            userId: OWNER,
        });

        return id;
    });
    branchId = await harness.run(async (ctx: any) => await ctx.db.insert("threads", { status: "active", title: "", userId: OWNER }));
    const minted = await mintUnlockProof({ epoch: parentEpoch, threadId: parentId, userId: OWNER }, SECRET, Date.now());

    parentProof = minted.proof;
});

const inherit = () =>
    harness.run(async (ctx: any) => await inheritPasscodeHandler(ctx, { sourceThreadId: parentId as never, targetThreadId: branchId as never }));

describe("a branch of a locked chat", () => {
    it("is locked, under a new epoch, and opens with the same passcode", async () => {
        await inherit();

        const branch = await harness.run(async (ctx: any) => await ctx.db.get(branchId));
        const row = await harness.run(async (ctx: any) => await readPasscodeRow(ctx.db, branchId as never));

        expect(branch?.lockedAt).toBeTypeOf("number");
        expect(row?.epoch).not.toBe(parentEpoch);
        expect(await verifyPasscode(PASSCODE, { hash: row!.hash, iterations: row!.iterations, salt: row!.salt })).toBe(true);
    });

    it("reads its messages and title only with a proof for the BRANCH id", async () => {
        await inherit();
        const row = await harness.run(async (ctx: any) => await readPasscodeRow(ctx.db, branchId as never));
        const minted = await mintUnlockProof({ epoch: row!.epoch, threadId: branchId, userId: OWNER }, SECRET, Date.now());
        const branchProof = minted.proof;

        const withoutProof = await harness.run(async (ctx: any) => await resolveThreadReadAccess(ctx, branchId as never, OWNER));

        expect(withoutProof?.kind).toBe("locked");
        const withProof = await harness.run(async (ctx: any) => await resolveThreadReadAccess(ctx, branchId as never, OWNER, branchProof));

        expect(withProof?.kind).toBe("full");
    });

    it("refuses the PARENT's proof for the branch", async () => {
        await inherit();

        const refused = await harness.run(async (ctx: any) => await isUnlockProofValid(ctx.db, { _id: branchId }, OWNER, parentProof, Date.now()));

        expect(refused).toBe(false);
    });

    it("refuses the owner with no proof, with the locked code", async () => {
        await inherit();

        const access = await harness.run(async (ctx: any) => await resolveThreadReadAccess(ctx, branchId as never, OWNER));

        expect(access?.kind).toBe("locked");
    });

    it("fails and creates nothing when the parent has no passcode row", async () => {
        await harness.run(async (ctx: any) => {
            const rows = await ctx.db
                .query("threadPasscodes")
                .withIndex("by_thread", (q: any) => q.eq("threadId", parentId))
                .collect();

            for (const row of rows) {
                await ctx.db.delete(row._id);
            }
        });

        await expect(inherit()).rejects.toThrow(MISSING_PASSCODE);

        const branch = await harness.run(async (ctx: any) => await ctx.db.get(branchId));

        expect(branch?.lockedAt).toBeUndefined();
    });

    it("cleanup removes the branch's passcode rows", async () => {
        await inherit();
        await harness.run(async (ctx: any) => await dropPasscodeRowsHandler(ctx, { threadId: branchId as never }));

        expect(await harness.run(async (ctx: any) => await readPasscodeRow(ctx.db, branchId as never))).toBeNull();
        expect(await harness.run(async (ctx: any) => await readPasscodeRow(ctx.db, parentId as never))).not.toBeNull();
    });
});
