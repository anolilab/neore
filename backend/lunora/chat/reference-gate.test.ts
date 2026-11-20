/**
 * The reference images of `/chat/media` are checked in two steps (`chat/reference-gate.ts`): the rows on the caller's shard, then
 * each referenced chat on its owner's shard. The harness keeps one database for every shard, so these tests check the decisions;
 * the routing between shards is covered only by e2e.
 */
import { REFERENCE_MEDIA_CAPS } from "@neore/ai/models";
import { lunoraTest } from "@lunora/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { endThreadAttach } from "../agent/file-attach-thread";
import { fileAttachInThread } from "../agent/file-attach-claim";
import { mintUnlockProof, newPasscodeEpoch } from "../lib/thread-lock";
import schema from "../schema";
import { gateReferenceRowsOnCallerShard, holdReferenceChatOnShard, renewReferenceChatOnShard, threadReadableOnShard } from "./reference-gate";

const SECRET = "test-storage-signing-secret";
const OWNER = "reference-owner";
const COLLAB = "reference-collaborator";
const OPEN_URL = "https://files.example.test/open.png";
const LOCKED_URL = "https://files.example.test/locked.png";
const COLLAB_LOCKED_URL = "https://files.example.test/collab-locked.png";
const COLLAB_OPEN_URL = "https://files.example.test/collab-open.png";
const DOC_URL = "data:image/png;base64,AAAA";

let harness: ReturnType<typeof lunoraTest>;
let epoch: string;

let ownerOpenId: string;
let ownerLockedId: string;
let collabLockedId: string;
let openFileId: string;
let lockedFileId: string;
let collabLockedFileId: string;
let openDocId: string;

const run = <T>(body: (ctx: any) => Promise<T>): Promise<T> => harness.run(body as never);

const insertThread = async (userId: string, locked: boolean) =>
    await run(async (ctx) => {
        const threadId = await ctx.db.insert("threads", { status: "active", title: "Chat", userId, ...(locked && { lockedAt: 2 }) });

        if (locked) {
            await ctx.db.insert("threadPasscodes", {
                createdAt: 1,
                epoch,
                failedAttempts: 0,
                hash: "unused-by-proofs",
                iterations: 1000,
                salt: "unused-by-proofs",
                threadId,
                updatedAt: 1,
                userId,
            });
        }

        return threadId as string;
    });

const insertFile = async (userId: string, chatId: string, url: string) =>
    await run(async (ctx) => (await ctx.db.insert("files", { chatId, name: "image.png", size: 1, type: "image/png", url, userId })) as string);

const insertDocument = async (userId: string, threadId: string, content: string) =>
    await run(async (ctx) => (await ctx.db.insert("documents", { content, kind: "image", threadId, title: "Image", userId, version: 1 })) as string);

const grant = async (threadId: string, userId: string) =>
    await run(async (ctx) => await ctx.db.insert("threadAccess", { grantedAt: 0, grantedBy: OWNER, ownerId: OWNER, permission: "read", threadId, userId }));

const proofFor = async (threadId: string, userId: string) => {
    const { proof } = await mintUnlockProof({ epoch, threadId, userId }, SECRET, Date.now());

    return proof;
};

/** The two steps as `/chat/media` runs them: the rows on the caller's shard, then each chat on its owner's shard. */
const refusedFor = async (userId: string, references: { id: string; url: string }[], targetThreadId: string, unlockProof?: string): Promise<boolean> => {
    const rows = await run(
        async (ctx) =>
            await ctx.runQuery(gateReferenceRowsOnCallerShard as never, {
                referenceIds: references.map((reference) => reference.id),
                referenceImages: references.map((reference) => reference.url),
                userId,
            }),
    );

    if ((rows as { refused: boolean }).refused) {
        return true;
    }

    for (const chatId of (rows as { chatIds: string[] }).chatIds) {
        const { readable } = await run(
            async (ctx) =>
                await ctx.runQuery(threadReadableOnShard as never, {
                    threadId: chatId,
                    unlockProof: chatId === targetThreadId ? unlockProof : undefined,
                    userId,
                }),
        );

        if (!(readable as boolean)) {
            return true;
        }
    }

    return false;
};

const readableFor = async (threadId: string, userId: string, unlockProof?: string): Promise<boolean> => {
    const { readable } = await run(async (ctx) => await ctx.runQuery(threadReadableOnShard as never, { threadId, unlockProof, userId }));

    return readable as boolean;
};

beforeEach(async () => {
    process.env.STORAGE_SIGNING_SECRET = SECRET;
    harness = lunoraTest(schema as never);
    epoch = newPasscodeEpoch();

    ownerOpenId = await insertThread(OWNER, false);
    ownerLockedId = await insertThread(OWNER, true);
    collabLockedId = await insertThread(COLLAB, true);

    openFileId = await insertFile(OWNER, ownerOpenId, OPEN_URL);
    lockedFileId = await insertFile(OWNER, ownerLockedId, LOCKED_URL);
    collabLockedFileId = await insertFile(COLLAB, collabLockedId, COLLAB_LOCKED_URL);
    openDocId = await insertDocument(OWNER, ownerOpenId, DOC_URL);
});

describe("a media request's references: the rows on the caller's shard", () => {
    it("serves the caller's own file", async () => {
        await expect(refusedFor(OWNER, [{ id: `file:${openFileId}`, url: OPEN_URL }], ownerOpenId)).resolves.toBe(false);
    });

    it("serves the caller's own document", async () => {
        await expect(refusedFor(OWNER, [{ id: `doc:${openDocId}`, url: DOC_URL }], ownerOpenId)).resolves.toBe(false);
    });

    it("refuses a reference whose URL is not its id's own URL", async () => {
        await expect(refusedFor(OWNER, [{ id: `file:${openFileId}`, url: LOCKED_URL }], ownerOpenId)).resolves.toBe(true);
    });

    it("refuses another user's file, even under its own URL", async () => {
        await expect(refusedFor(COLLAB, [{ id: `file:${openFileId}`, url: OPEN_URL }], ownerOpenId)).resolves.toBe(true);
    });

    it("refuses any one reference when another is refused", async () => {
        await expect(
            refusedFor(
                OWNER,
                [
                    { id: `file:${openFileId}`, url: OPEN_URL },
                    { id: `file:${lockedFileId}`, url: LOCKED_URL },
                ],
                ownerOpenId,
            ),
        ).resolves.toBe(true);
    });

    it("refuses a malformed id", async () => {
        await expect(refusedFor(OWNER, [{ id: "not-an-id", url: OPEN_URL }], ownerOpenId)).resolves.toBe(true);
    });

    it("refuses a well-formed id that names no row, without a lookup error", async () => {
        await expect(refusedFor(OWNER, [{ id: "file:not-a-real-id", url: OPEN_URL }], ownerOpenId)).resolves.toBe(true);
        await expect(refusedFor(OWNER, [{ id: "doc:not-a-real-id", url: DOC_URL }], ownerOpenId)).resolves.toBe(true);
    });

    it("refuses a list longer than the media cap, before any row is read", async () => {
        const repeated = Array.from({ length: REFERENCE_MEDIA_CAPS.images + 1 }, () => {
            return { id: `file:${openFileId}`, url: OPEN_URL };
        });

        await expect(refusedFor(OWNER, repeated, ownerOpenId)).resolves.toBe(true);
    });
});

describe("a media request's references: each chat on its owner's shard", () => {
    it("reads the caller's own unlocked chat", async () => {
        await expect(readableFor(ownerOpenId, OWNER)).resolves.toBe(true);
    });

    it("refuses the caller's own locked chat when no proof is given", async () => {
        await expect(readableFor(ownerLockedId, OWNER)).resolves.toBe(false);
    });

    it("reads a locked chat with that chat's proof", async () => {
        const proof = await proofFor(ownerLockedId, OWNER);

        await expect(readableFor(ownerLockedId, OWNER, proof)).resolves.toBe(true);
    });

    it("serves a collaborator's own file attached to a chat shared with them", async () => {
        await grant(ownerOpenId, COLLAB);
        const sharedFileId = await insertFile(COLLAB, ownerOpenId, COLLAB_OPEN_URL);

        await expect(refusedFor(COLLAB, [{ id: `file:${sharedFileId}`, url: COLLAB_OPEN_URL }], ownerOpenId)).resolves.toBe(false);
    });

    it("refuses a collaborator's file attached to a chat shared with them when the grant is missing", async () => {
        const unsharedFileId = await insertFile(COLLAB, ownerOpenId, COLLAB_OPEN_URL);

        await expect(refusedFor(COLLAB, [{ id: `file:${unsharedFileId}`, url: COLLAB_OPEN_URL }], ownerOpenId)).resolves.toBe(true);
    });

    it("refuses a shared chat that is locked, even for a collaborator with a grant", async () => {
        await grant(ownerLockedId, COLLAB);

        await expect(readableFor(ownerLockedId, COLLAB)).resolves.toBe(false);
    });

    it("refuses a locked chat's file when the proof is for another chat than the target", async () => {
        const proof = await proofFor(ownerLockedId, OWNER);

        await expect(refusedFor(OWNER, [{ id: `file:${lockedFileId}`, url: LOCKED_URL }], ownerOpenId, proof)).resolves.toBe(true);
    });

    it("refuses a collaborator's file from their own locked chat, even with the target's proof", async () => {
        const proof = await proofFor(ownerLockedId, OWNER);

        await expect(refusedFor(COLLAB, [{ id: `file:${collabLockedFileId}`, url: COLLAB_LOCKED_URL }], ownerLockedId, proof)).resolves.toBe(true);
    });

    it("serves the caller's locked-chat file when the request carries that chat's proof and names it as the target", async () => {
        const proof = await proofFor(ownerLockedId, OWNER);

        await expect(refusedFor(OWNER, [{ id: `file:${lockedFileId}`, url: LOCKED_URL }], ownerLockedId, proof)).resolves.toBe(false);
    });
});

describe("a queued media job rechecks each referenced chat on its owner's shard", () => {
    let requestSeq = 0;

    /** The job's own recheck (`holdReferenceChatOnShard`): a fresh request id per call, so each check takes its own hold. */
    const heldFor = async (threadId: string, userId: string, requestedAt: number): Promise<boolean> => {
        requestSeq += 1;
        const { held } = (await run(
            async (ctx) => await ctx.runMutation(holdReferenceChatOnShard as never, { requestedAt, requestId: `held-${String(requestSeq)}`, threadId, userId }),
        )) as { held: boolean };

        return held;
    };

    it("holds an unlocked chat the caller owns", async () => {
        await expect(heldFor(ownerOpenId, OWNER, 1)).resolves.toBe(true);
    });

    it("holds a chat locked before the check, for its owner", async () => {
        await expect(heldFor(ownerLockedId, OWNER, 3)).resolves.toBe(true);
    });

    it("does not hold a chat locked after the check", async () => {
        await expect(heldFor(ownerLockedId, OWNER, 1)).resolves.toBe(false);
    });

    it("does not hold a locked chat for a collaborator", async () => {
        await expect(heldFor(ownerLockedId, COLLAB, 3)).resolves.toBe(false);
    });

    it("does not hold a chat its owner is deleting, locked or not", async () => {
        const lockedDeleting = await insertThread(OWNER, true);

        await run(async (ctx) => await ctx.db.patch("threads", lockedDeleting as never, { deletingAt: 2 }));

        const openDeleted = await insertThread(OWNER, false);

        await run(async (ctx) => await ctx.db.patch("threads", openDeleted as never, { deleted: true, deletedAt: 2 }));

        await expect(heldFor(lockedDeleting, OWNER, 3)).resolves.toBe(false);
        await expect(heldFor(openDeleted, OWNER, 1)).resolves.toBe(false);
    });

    it("does not hold an unlocked chat a collaborator has no grant to", async () => {
        await expect(heldFor(ownerOpenId, COLLAB, 1)).resolves.toBe(false);
    });
});

describe("a queued media job holds the chats it reads against a lock until the provider has its references", () => {
    type Hold = { claimedAt?: number; held: boolean };

    const holdFor = async (threadId: string, userId: string, requestId: string, requestedAt: number): Promise<Hold> =>
        (await run(async (ctx) => await ctx.runMutation(holdReferenceChatOnShard as never, { requestedAt, requestId, threadId, userId }))) as Hold;

    const attachInFlight = async (threadId: string): Promise<boolean> => await run(async (ctx) => await fileAttachInThread(ctx, threadId));

    it("takes an attach claim on an unlocked chat, which blocks a lock until it is released", async () => {
        const { claimedAt, held } = await holdFor(ownerOpenId, OWNER, "job-open", 1);

        expect(held).toBe(true);
        expect(claimedAt).toBeDefined();
        await expect(attachInFlight(ownerOpenId)).resolves.toBe(true);

        await run(async (ctx) => await ctx.runMutation(endThreadAttach as never, { claimedAt, requestId: "job-open", threadId: ownerOpenId }));
        await expect(attachInFlight(ownerOpenId)).resolves.toBe(false);
    });

    it("takes no claim on a chat locked before the check, which is already closed to attaches", async () => {
        const { claimedAt, held } = await holdFor(ownerLockedId, OWNER, "job-locked", 3);

        expect(held).toBe(true);
        expect(claimedAt).toBeUndefined();
        await expect(attachInFlight(ownerLockedId)).resolves.toBe(false);
    });

    it("takes no claim on a chat the caller may not read, and holds nothing", async () => {
        const { claimedAt, held } = await holdFor(ownerOpenId, COLLAB, "job-denied", 1);

        expect(held).toBe(false);
        expect(claimedAt).toBeUndefined();
        await expect(attachInFlight(ownerOpenId)).resolves.toBe(false);
    });

    it("keeps the hold past the attach TTL, so a slow chat check or provider call cannot lose it, and lapses after the hold's own TTL", async () => {
        vi.useFakeTimers({ toFake: ["Date"] });

        try {
            vi.setSystemTime(new Date("2026-11-20T12:00:00Z"));
            const { claimedAt } = await holdFor(ownerOpenId, OWNER, "job-long", 1);

            // Past the 3-minute attach window, still inside the hold.
            vi.setSystemTime(new Date("2026-11-20T12:04:00Z"));
            await expect(attachInFlight(ownerOpenId)).resolves.toBe(true);

            vi.setSystemTime(new Date("2026-11-20T12:14:00Z"));
            await expect(attachInFlight(ownerOpenId)).resolves.toBe(true);

            // Past the hold's TTL: a job that never released it no longer blocks locks.
            vi.setSystemTime(new Date("2026-11-20T12:16:00Z"));
            await expect(attachInFlight(ownerOpenId)).resolves.toBe(false);
            expect(claimedAt).toBeDefined();
        } finally {
            vi.useRealTimers();
        }
    });

    const renewFor = async (threadId: string, userId: string, requestId: string, claimedAt: number, requestedAt: number): Promise<boolean> => {
        const { held } = (await run(
            async (ctx) => await ctx.runMutation(renewReferenceChatOnShard as never, { claimedAt, requestedAt, requestId, threadId, userId }),
        )) as { held: boolean };

        return held;
    };

    it("renews a hold that lapsed while the job waited, on a chat that stayed unlocked", async () => {
        vi.useFakeTimers({ toFake: ["Date"] });

        try {
            vi.setSystemTime(new Date("2026-11-20T12:00:00Z"));
            const { claimedAt } = await holdFor(ownerOpenId, OWNER, "job-renew", 1);

            vi.setSystemTime(new Date("2026-11-20T12:20:00Z"));
            await expect(attachInFlight(ownerOpenId)).resolves.toBe(false);

            await expect(renewFor(ownerOpenId, OWNER, "job-renew", claimedAt as number, 1)).resolves.toBe(true);
            await expect(attachInFlight(ownerOpenId)).resolves.toBe(true);

            // The renewal runs the full hold again from now.
            vi.setSystemTime(new Date("2026-11-20T12:36:00Z"));
            await expect(attachInFlight(ownerOpenId)).resolves.toBe(false);
        } finally {
            vi.useRealTimers();
        }
    });

    it("refuses to renew a lapsed hold once its chat was locked in the gap", async () => {
        vi.useFakeTimers({ toFake: ["Date"] });

        try {
            vi.setSystemTime(new Date("2026-11-20T12:00:00Z"));
            const { claimedAt } = await holdFor(ownerOpenId, OWNER, "job-locked-gap", 1);

            vi.setSystemTime(new Date("2026-11-20T12:20:00Z"));
            await run(async (ctx) => await ctx.db.patch("threads", ownerOpenId as never, { lockedAt: 2 }));

            await expect(renewFor(ownerOpenId, OWNER, "job-locked-gap", claimedAt as number, 1)).resolves.toBe(false);
            await expect(attachInFlight(ownerOpenId)).resolves.toBe(false);
        } finally {
            vi.useRealTimers();
        }
    });
});
