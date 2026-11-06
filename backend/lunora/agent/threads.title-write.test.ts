/**
 * The generated-title write checks the title the run read, in the same transaction as the patch, and refuses a thread
 * that may no longer be titled. A rename committed after the run's last check must survive.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Id } from "../_generated/dataModel";
import schema from "../schema";
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

const writeTitle = async (threadId: string, expectedTitle: string, requestedBy?: string) =>
    await harness.run(
        async (context: any) => await writeTitleIfUnchanged(context, { expectedTitle, requestedBy, threadId: threadId as Id<"threads">, title: "Generated" }),
    );

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
