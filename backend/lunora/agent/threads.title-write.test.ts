/**
 * The generated-title write checks the title the run read, in the same transaction as the patch, and refuses a thread
 * that may no longer be titled. A rename committed after the run's last check must survive.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { sha256Hex } from "../lib/crypto";
import { MAX_LENGTH } from "../lib/validators";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { BRANCH_ROOT } from "./branch-tree";
import { writeTitleIfUnchanged } from "./threads";

const OWNER = "user-owner";

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

/** Writes "Generated" as the title the run read `expectedTitle`: the write gets the digest of that title, as the job does. */
const writeTitle = async (threadId: string, expectedTitle: string, requestedBy?: string, expectedPromptId?: string) => {
    const expectedTitleDigest = await sha256Hex(expectedTitle);

    return await harness.run(
        async (context: any) =>
            await writeTitleIfUnchanged(context, {
                expectedPromptId,
                expectedTitleDigest,
                requestedBy,
                threadId: threadId as Id<"threads">,
                title: "Generated",
            }),
    );
};

const titleOf = async (threadId: string): Promise<string | undefined> => {
    const thread = (await harness.run(async (context: any) => await context.db.get("threads", threadId))) as { title?: string };

    return thread.title;
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

    it("refuses a locked thread, whose title is its content", async () => {
        const threadId = await threadWith({ lockedAt: 1000 });

        await expect(writeTitle(threadId, "Old")).resolves.toBe(false);
        await expect(titleOf(threadId)).resolves.toBe("Old");
    });

    it("refuses a deleted thread", async () => {
        const threadId = await threadWith({ deletedAt: 1000 });

        await expect(writeTitle(threadId, "Old")).resolves.toBe(false);
        await expect(titleOf(threadId)).resolves.toBe("Old");
    });

    it("refuses a host-run thread", async () => {
        const threadId = await threadWith({ runner: "host" });

        await expect(writeTitle(threadId, "Old")).resolves.toBe(false);
        await expect(titleOf(threadId)).resolves.toBe("Old");
    });
});

describe("writing a title to a thread that is gone", () => {
    it("refuses a thread that no longer exists", async () => {
        const threadId = await threadWith();

        await harness.run(async (context: any) => await context.db.delete("threads", threadId));

        await expect(writeTitle(threadId, "Old")).resolves.toBe(false);
    });
});

describe("writing a generated title for a requester", () => {
    const GRANTEE = "user-grantee";

    it("writes for an admin grantee, and refuses the write once the grant is revoked, keeping the title", async () => {
        const threadId = await threadWith({ title: "Old" });
        const grantId = (await harness.run(
            async (context: any) => await context.db.insert("threadAccess", { grantedAt: 0, grantedBy: OWNER, permission: "admin", threadId, userId: GRANTEE }),
        )) as string;

        await expect(writeTitle(threadId, "Old", GRANTEE)).resolves.toBe(true);

        await harness.run(async (context: any) => await context.db.delete("threadAccess", grantId));

        // The grant is revoked after the job's own check: the write itself refuses, so the title it generated is not kept.
        await expect(writeTitle(threadId, "Generated", GRANTEE)).resolves.toBe(false);
        await expect(titleOf(threadId)).resolves.toBe("Generated");
    });

    it("writes for the owner, who holds admin access without a grant", async () => {
        const threadId = await threadWith({ title: "Old" });

        await expect(writeTitle(threadId, "Old", OWNER)).resolves.toBe(true);
        await expect(titleOf(threadId)).resolves.toBe("Generated");
    });
});

describe("writing a title that is longer than the title limit", () => {
    it("writes when the stored title is longer than the limit, comparing a digest of it", async () => {
        const longTitle = "x".repeat(MAX_LENGTH.long + 1);
        const threadId = await threadWith({ title: longTitle });

        await expect(writeTitle(threadId, longTitle)).resolves.toBe(true);
        await expect(titleOf(threadId)).resolves.toBe("Generated");
    });
});

describe("writing a title at the time of the write, against the active branch", () => {
    /** A thread with a prompt and a reply under it, the reply as the active leaf. */
    const branchedThread = async () => {
        const threadId = await threadWith({ title: "Old" });
        const row = async (order: number, fields: Record<string, unknown>) =>
            (await harness.run(
                async (context: any) =>
                    await context.db.insert("messages", { order, status: "success", stepOrder: 0, threadId, tool: false, userId: OWNER, ...fields }),
            )) as string;
        const prompt = await row(1, { message: { content: "Plan a trip", role: "user" } });
        const reply = await row(2, { message: { content: "Sure", role: "assistant" }, parentMessageId: prompt });

        await harness.run(async (context: any) => await context.db.patch("threads", threadId, { activeLeafMessageId: reply }));

        return { prompt, row, threadId };
    };

    it("writes while the prompt the title came from is still on the active path", async () => {
        const { prompt, threadId } = await branchedThread();

        await expect(writeTitle(threadId, "Old", undefined, prompt)).resolves.toBe(true);
    });

    it("refuses the write once the leaf is on another branch the prompt is not on, and keeps the title", async () => {
        const { prompt, row, threadId } = await branchedThread();

        // The first prompt was edited while the title was generated: the edit is another root, and the leaf moved to it.
        const edited = await row(3, { message: { content: "Plan a trip to Porto", role: "user" }, parentMessageId: BRANCH_ROOT });

        await harness.run(async (context: any) => await context.db.patch("threads", threadId, { activeLeafMessageId: edited }));

        await expect(writeTitle(threadId, "Old", undefined, prompt)).resolves.toBe(false);
        await expect(titleOf(threadId)).resolves.toBe("Old");
    });
});
