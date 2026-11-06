/**
 * A generated title: the prompt it is read from (the earliest user prompt within the active path's recent window, read at run time), the
 * admission that checks the thread and takes the charge in one transaction right before the model call, and the write, which checks
 * the same things again in its own transaction.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { sha256Hex } from "../lib/crypto";
import { MAX_LENGTH } from "../lib/validators";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { BRANCH_ROOT } from "./branch-tree";
import { admitTitleRun, readTitlePrompt, recordTitleAnswer, TITLE_CHARGE_SCOPE, TITLE_READ_WINDOW, titlePromptIn, writeTitleIfUnchanged } from "./thread-title";

const OWNER = "user-owner";
const GRANTEE = "user-grantee";

let harness: ReturnType<typeof lunoraTest>;

beforeEach(() => {
    harness = lunoraTest(schema as never);
});

afterEach(() => {
    harness.close();
});

const threadWith = async (fields: Record<string, unknown> = {}) =>
    (await harness.run(
        async (context: any) => await context.db.insert("threads", { model: "gpt-4o", status: "active", title: "Old", userId: OWNER, ...fields }),
    )) as string;

/** Inserts a message on a thread with the given order and fields; each branch test builds its rows through it. */
const rowIn =
    (threadId: string) =>
    async (order: number, fields: Record<string, unknown>): Promise<string> =>
        (await harness.run(
            async (context: any) =>
                await context.db.insert("messages", { order, status: "success", stepOrder: 0, threadId, tool: false, userId: OWNER, ...fields }),
        )) as string;

const setLeaf = async (threadId: string, leaf: string) => {
    await harness.run(async (context: any) => await context.db.patch("threads", threadId, { activeLeafMessageId: leaf }));
};

/** Writes `title` as a run that read `expectedTitle` (the write gets its digest, as the job does), from `promptId` when given. */
const writeTitle = async (threadId: string, expectedTitle: string, options: { promptId?: string; requestedBy?: string; title?: string } = {}) => {
    const expectedTitleDigest = await sha256Hex(expectedTitle);

    return await harness.run(
        async (context: any) =>
            await writeTitleIfUnchanged(context, {
                expectedTitleDigest,
                promptId: options.promptId,
                requestedBy: options.requestedBy,
                threadId: threadId as Id<"threads">,
                title: options.title ?? "Generated",
            }),
    );
};

const titleOf = async (threadId: string): Promise<string | undefined> => {
    const thread = (await harness.run(async (context: any) => await context.db.get("threads", threadId))) as { title?: string };

    return thread.title;
};

const promptOf = async (threadId: string) => await harness.run(async (context: any) => await titlePromptIn(context, await context.db.get("threads", threadId)));

const admit = async (threadId: string, chargeKey: string, options: { expectedTitle?: string; promptId?: string; requestedBy?: string } = {}) =>
    (await harness.run(
        async (context: any) =>
            await context.runMutation(admitTitleRun as never, {
                chargeKey,
                expectedTitleDigest: await sha256Hex(options.expectedTitle ?? "Old"),
                promptId: options.promptId,
                requestedBy: options.requestedBy,
                threadId,
                userId: OWNER,
            }),
    )) as { claimedAt?: number; outcome: string; promptId?: string; reason?: string; title?: string };

const chargeKeys = async (): Promise<string[]> => {
    const claims = (await harness.run(async (context: any) => await context.db.query("idempotencyClaims").collect())) as { key: string; scope: string }[];

    return claims.filter((claim) => claim.scope === TITLE_CHARGE_SCOPE).map((claim) => claim.key);
};

describe("writing a generated title", () => {
    it("writes the title while the thread still carries the one the run read", async () => {
        const threadId = await threadWith();

        await expect(writeTitle(threadId, "Old")).resolves.toBe(true);
        await expect(titleOf(threadId)).resolves.toBe("Generated");
    });

    it("keeps a rename committed after the run read the title", async () => {
        const threadId = await threadWith({ title: "Renamed by the owner" });

        await expect(writeTitle(threadId, "Old")).resolves.toBe(false);
        await expect(titleOf(threadId)).resolves.toBe("Renamed by the owner");
    });

    it("treats a thread with no title as the empty title", async () => {
        const threadId = await threadWith({ title: undefined });

        await expect(writeTitle(threadId, "")).resolves.toBe(true);
        await expect(titleOf(threadId)).resolves.toBe("Generated");
    });

    it.each([
        ["a locked thread, whose title is its content", { lockedAt: 1000 }],
        ["a deleted thread", { deletedAt: 1000 }],
        ["a host-run thread", { runner: "host" }],
    ])("refuses %s", async (_name, fields) => {
        const threadId = await threadWith(fields);

        await expect(writeTitle(threadId, "Old")).resolves.toBe(false);
        await expect(titleOf(threadId)).resolves.toBe("Old");
    });

    it("refuses a thread that no longer exists", async () => {
        const threadId = await threadWith();

        await harness.run(async (context: any) => await context.db.delete("threads", threadId));

        await expect(writeTitle(threadId, "Old")).resolves.toBe(false);
    });

    it("writes when the stored title is longer than the limit, comparing a digest of it", async () => {
        const longTitle = "x".repeat(MAX_LENGTH.long + 1);
        const threadId = await threadWith({ title: longTitle });

        await expect(writeTitle(threadId, longTitle)).resolves.toBe(true);
        await expect(titleOf(threadId)).resolves.toBe("Generated");
    });

    it("reports a title that landed in an earlier try as saved, even though the digest has moved on, and once the chat is locked since", async () => {
        const threadId = await threadWith({ title: "Generated" });

        await expect(writeTitle(threadId, "Old")).resolves.toBe(true);

        await harness.run(async (context: any) => await context.db.patch("threads", threadId, { lockedAt: 1000 }));
        await expect(writeTitle(threadId, "Old")).resolves.toBe(true);
    });
});

describe("writing a generated title for a requester", () => {
    it("writes for an admin grantee, and refuses the write once the grant is revoked, keeping the title", async () => {
        const threadId = await threadWith({ title: "Old" });
        const grantId = (await harness.run(
            async (context: any) => await context.db.insert("threadAccess", { grantedAt: 0, grantedBy: OWNER, permission: "admin", threadId, userId: GRANTEE }),
        )) as string;

        await expect(writeTitle(threadId, "Old", { requestedBy: GRANTEE })).resolves.toBe(true);

        await harness.run(async (context: any) => await context.db.delete("threadAccess", grantId));

        await expect(writeTitle(threadId, "Generated", { requestedBy: GRANTEE, title: "Renewed" })).resolves.toBe(false);
        await expect(titleOf(threadId)).resolves.toBe("Generated");
    });

    it("writes for the owner, who holds admin access without a grant", async () => {
        const threadId = await threadWith({ title: "Old" });

        await expect(writeTitle(threadId, "Old", { requestedBy: OWNER })).resolves.toBe(true);
    });
});

describe("the prompt a title comes from", () => {
    it("is the earliest successful user prompt, skipping a failed one", async () => {
        const threadId = await threadWith();
        const row = rowIn(threadId);

        await row(1, { message: { content: "A prompt that failed", role: "user" }, status: "failed" });
        const prompt = await row(2, { message: { content: "Plan a trip", role: "user" } });

        await row(3, { message: { content: "Sure", role: "assistant" } });
        await row(4, { message: { content: "And the hotels?", role: "user" } });

        await expect(promptOf(threadId)).resolves.toEqual({ id: prompt, text: "Plan a trip" });
    });

    it("is read from the active branch, not from a prompt the owner edited away", async () => {
        const threadId = await threadWith();
        const row = rowIn(threadId);
        const original = await row(1, { message: { content: "Plan a trip", role: "user" } });

        await row(2, { message: { content: "Sure", role: "assistant" }, parentMessageId: original });
        const edited = await row(3, { message: { content: "Plan a trip to Porto", role: "user" }, parentMessageId: BRANCH_ROOT });

        await setLeaf(threadId, edited);

        await expect(promptOf(threadId)).resolves.toEqual({ id: edited, text: "Plan a trip to Porto" });
    });

    it("comes from the recent window of a long chat, not from a first prompt long out of view", async () => {
        const threadId = await threadWith();
        const row = rowIn(threadId);

        await row(0, { message: { content: "An old subject", role: "user" } });

        let order = 1;

        for (; order <= TITLE_READ_WINDOW; order += 1) {
            await row(order, { message: { content: `Reply ${order}`, role: "assistant" } });
        }

        const recent = await row(order, { message: { content: "The subject now", role: "user" } });

        await row(order + 1, { message: { content: "Sure", role: "assistant" } });

        // Past the window, a branched chat is titled too: there is no length past which it is refused.
        await expect(promptOf(threadId)).resolves.toEqual({ id: recent, text: "The subject now" });
    }, 60_000);

    it("is found on a chat whose stored leaf row is gone, from the path the thread shows", async () => {
        const threadId = await threadWith();
        const row = rowIn(threadId);
        const prompt = await row(1, { message: { content: "Plan a trip", role: "user" } });
        const gone = await row(2, { message: { content: "Sure", role: "assistant" }, parentMessageId: prompt });

        await setLeaf(threadId, gone);
        await harness.run(async (context: any) => await context.db.delete("messages", gone));

        await expect(promptOf(threadId)).resolves.toEqual({ id: prompt, text: "Plan a trip" });
    });

    it("is not read at all for a locked chat, or for a requester without admin access", async () => {
        const locked = await threadWith({ lockedAt: 1000 });
        const open = await threadWith();

        await rowIn(locked)(1, { message: { content: "Secret plans", role: "user" } });
        await rowIn(open)(1, { message: { content: "Plan a trip", role: "user" } });

        const read = async (threadId: string, requestedBy: string) =>
            await harness.run(async (context: any) => await context.runQuery(readTitlePrompt as never, { requestedBy, threadId }));

        await expect(read(locked, OWNER)).resolves.toEqual({ outcome: "refused" });
        await expect(read(open, GRANTEE)).resolves.toEqual({ outcome: "refused" });
        await expect(read(open, OWNER)).resolves.toMatchObject({ outcome: "prompt", text: "Plan a trip" });
    });
});

describe("the prompt a title is written from, at the time of the write", () => {
    it("writes while the prompt is still on the active path, and refuses once the leaf is on a branch it is not on", async () => {
        const threadId = await threadWith();
        const row = rowIn(threadId);
        const prompt = await row(1, { message: { content: "Plan a trip", role: "user" } });
        const reply = await row(2, { message: { content: "Sure", role: "assistant" }, parentMessageId: prompt });

        await setLeaf(threadId, reply);
        await expect(writeTitle(threadId, "Old", { promptId: prompt })).resolves.toBe(true);

        const edited = await row(3, { message: { content: "Plan a trip to Porto", role: "user" }, parentMessageId: BRANCH_ROOT });

        await setLeaf(threadId, edited);
        await expect(writeTitle(threadId, "Generated", { promptId: prompt, title: "Stale" })).resolves.toBe(false);
        await expect(titleOf(threadId)).resolves.toBe("Generated");
    });

    it("refuses a deleted prompt on an unbranched chat", async () => {
        const threadId = await threadWith();
        const row = rowIn(threadId);
        const prompt = await row(1, { message: { content: "Plan a trip", role: "user" } });

        await row(2, { message: { content: "Sure", role: "assistant" } });
        await harness.run(async (context: any) => await context.db.delete("messages", prompt));

        await expect(writeTitle(threadId, "Old", { promptId: prompt })).resolves.toBe(false);
        await expect(titleOf(threadId)).resolves.toBe("Old");
    });

    it("refuses a source that is not a user prompt", async () => {
        const threadId = await threadWith();
        const reply = await rowIn(threadId)(1, { message: { content: "Sure", role: "assistant" } });

        await expect(writeTitle(threadId, "Old", { promptId: reply })).resolves.toBe(false);
    });
});

describe("admitting a title's model call", () => {
    const threadWithPrompt = async (fields: Record<string, unknown> = {}) => {
        const threadId = await threadWith(fields);
        const prompt = await rowIn(threadId)(1, { message: { content: "Plan a trip", role: "user" } });

        return { prompt, threadId };
    };

    it("refuses a chat locked before the call, in the same step that would charge it, so its prompt is never sent", async () => {
        const { prompt, threadId } = await threadWithPrompt();

        await harness.run(async (context: any) => await context.db.patch("threads", threadId, { lockedAt: 1000 }));

        await expect(admit(threadId, `${threadId}:run`, { promptId: prompt })).resolves.toEqual({ outcome: "refused", reason: "ineligible" });
        expect(await chargeKeys()).toEqual([]);
    });

    it("refuses a prompt moved off the active path, and a requester who lost admin access, before charging", async () => {
        const { prompt, threadId } = await threadWithPrompt();

        await expect(admit(threadId, `${threadId}:a`, { requestedBy: GRANTEE })).resolves.toMatchObject({ reason: "access-withdrawn" });

        const edited = await rowIn(threadId)(2, { message: { content: "Plan a trip to Porto", role: "user" }, parentMessageId: BRANCH_ROOT });

        await setLeaf(threadId, edited);
        await expect(admit(threadId, `${threadId}:b`, { promptId: prompt })).resolves.toMatchObject({ reason: "prompt-moved" });
        expect(await chargeKeys()).toEqual([]);
    });

    it("admits a run once; a retry before an answer is recorded calls nothing", async () => {
        const { prompt, threadId } = await threadWithPrompt();

        await expect(admit(threadId, `${threadId}:run`, { promptId: prompt })).resolves.toMatchObject({ claimedAt: expect.any(Number), outcome: "admitted" });
        await expect(admit(threadId, `${threadId}:run`, { promptId: prompt })).resolves.toEqual({ outcome: "in-flight" });
    });

    it("hands a retry the recorded answer, so the title is written without a second model call", async () => {
        const { prompt, threadId } = await threadWithPrompt();
        const key = `${threadId}:run`;
        const { claimedAt } = await admit(threadId, key, { promptId: prompt });

        await expect(
            harness.run(
                async (context: any) =>
                    await context.runMutation(recordTitleAnswer as never, { chargeKey: key, claimedAt, promptId: prompt, title: "Lisbon trip" }),
            ),
        ).resolves.toBe(true);

        // The retry read another prompt; the answer is checked against the one it was generated from.
        await expect(admit(threadId, key, { promptId: "another-prompt" })).resolves.toEqual({
            claimedAt,
            outcome: "answered",
            promptId: prompt,
            title: "Lisbon trip",
        });
    });

    it("does not record an answer on a claim that is not the run's own", async () => {
        const { threadId } = await threadWithPrompt();
        const key = `${threadId}:run`;
        const { claimedAt } = await admit(threadId, key);

        await expect(
            harness.run(
                async (context: any) => await context.runMutation(recordTitleAnswer as never, { chargeKey: key, claimedAt: claimedAt! - 1, title: "Stale" }),
            ),
        ).resolves.toBe(false);
    });
});
