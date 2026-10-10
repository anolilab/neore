/**
 * `agent_threads.getThread` on a PUBLIC thread: the owner and a live grantee get
 * the full row; anyone else — a stranger, or no caller at all — gets the
 * redacted shape, never the owner id or system prompt.
 */
import { lunoraTest } from "@lunora/testing";
import { describe, expect, it, vi } from "vitest";

import schema from "../schema";
import { getThread } from "./threads";

// The real resolver reads the `user` row, and `user` is a `.global()` (D1) table
// the in-memory harness cannot write. Identity is not what is under test here.
vi.mock("../auth", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../auth")>()),
        getAuthUserIdentity: async (context: { auth: { userId?: string | null } }) =>
            context.auth.userId ? { subject: context.auth.userId, userId: context.auth.userId } : null,
    };
});

const SECRET_PROMPT = "owner's private system prompt";

const seed = async (harness: ReturnType<typeof lunoraTest>) =>
    await harness.run(async (context: any) => {
        const owner = "user-owner";
        const stranger = "user-stranger";
        const grantee = "user-grantee";
        const threadId = await context.db.insert("threads", {
            customSystemPrompt: SECRET_PROMPT,
            isPublic: true,
            organizationId: "org-1",
            publicAccessToken: "share-token",
            status: "active",
            title: "Shared",
            userId: owner,
        });

        await context.db.insert("threadAccess", { grantedAt: 0, grantedBy: owner, permission: "read", threadId, userId: grantee });

        return { grantee, owner, stranger, threadId };
    });

describe("getThread on a public thread", () => {
    it("gives the owner and a grantee the full row, everyone else the redacted shape", async () => {
        const harness = lunoraTest(schema as never);

        try {
            const { grantee, owner, stranger, threadId } = await seed(harness);

            const asOwner: any = await harness.withIdentity({ userId: owner }).query(getThread as never, { threadId } as never);
            const asGrantee: any = await harness.withIdentity({ userId: grantee }).query(getThread as never, { threadId } as never);
            const asStranger: any = await harness.withIdentity({ userId: stranger }).query(getThread as never, { threadId } as never);
            const asAnonymous: any = await harness.query(getThread as never, { threadId } as never);

            expect(asOwner).toMatchObject({ customSystemPrompt: SECRET_PROMPT, organizationId: "org-1", userId: owner });
            expect(asGrantee).toMatchObject({ customSystemPrompt: SECRET_PROMPT, userId: owner });

            for (const redacted of [asStranger, asAnonymous]) {
                expect(redacted).toMatchObject({ _id: threadId, isPublic: true, publicAccessToken: "share-token", title: "Shared" });
                expect(redacted).not.toHaveProperty("userId");
                expect(redacted).not.toHaveProperty("customSystemPrompt");
                expect(redacted).not.toHaveProperty("organizationId");
            }
        } finally {
            harness.close();
        }
    });
});
