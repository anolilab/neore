/**
 * Every client-reachable thread read goes through `resolveThreadReadAccess`.
 * On a PUBLIC thread, a stranger gets the redacted view or nothing on each of
 * those paths — never the raw row — while the owner and a live grantee get it
 * all. Organization membership grants nothing (vault included).
 */
import { lunoraTest } from "@lunora/testing";
import { describe, expect, it, vi } from "vitest";

import { getThreadWithAccess, checkThreadAccessBatchHandler } from "../agent/threads";
import { listMessagesByThreadId } from "../agent/messages";
import { resolveThreadReadAccess } from "../agent/thread-read-access";
import schema from "../schema";
import { getAttachmentsForChat } from "../vault/functions";
import { getThreadWithData } from "./composite";
import { getThread, getThreadUIMessages } from "./functions";
import { getThreadAccess } from "./sharing";

const ORG = "org-1";

// `user` is a `.global()` (D1) table the in-memory harness cannot write, so the
// session is read straight off the harness identity. Every caller shares ORG.
const { sessionFrom } = vi.hoisted(() => {
    return {
        sessionFrom: async (context: { auth: { userId?: string | null } }) =>
            context.auth.userId ? { activeOrganization: { id: "org-1" }, id: context.auth.userId, userId: context.auth.userId } : null,
    };
});

vi.mock("../lib/crpc-auth-helpers", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../lib/crpc-auth-helpers")>()),
        getSessionUserForQuery: sessionFrom,
        getSessionUserForQueryLite: sessionFrom,
    };
});

// `files` is audited, and its trigger writes the `.global()` `documentHistory`
// table the harness cannot store. Auditing is not what is under test.
vi.mock("../lib/audit-triggers", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../lib/audit-triggers")>()),
        auditTriggersFor: () => {
            return {};
        },
    };
});

vi.mock("../auth", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../auth")>()),
        getAuthUserIdentity: async (context: { auth: { userId?: string | null } }) =>
            context.auth.userId ? { subject: context.auth.userId, userId: context.auth.userId } : null,
    };
});

const SECRET_PROMPT = "owner's private system prompt";
const OWNER = "user-owner";
const GRANTEE = "user-grantee";
const WRITER = "user-writer";
const STRANGER = "user-stranger";

const seed = async (harness: ReturnType<typeof lunoraTest>) =>
    await harness.run(async (context: any) => {
        const threadId = await context.db.insert("threads", {
            customSystemPrompt: SECRET_PROMPT,
            isPublic: true,
            model: "gpt-4o",
            organizationId: ORG,
            publicAccessToken: "share-token",
            status: "active",
            title: "Shared",
            userId: OWNER,
        });

        await context.db.insert("threadAccess", { grantedAt: 0, grantedBy: OWNER, permission: "read", threadId, userId: GRANTEE });
        await context.db.insert("threadAccess", { grantedAt: 0, grantedBy: OWNER, permission: "write", threadId, userId: WRITER });
        await context.db.insert("threadAccess", { expiresAt: 1, grantedAt: 0, grantedBy: OWNER, permission: "admin", threadId, userId: "user-expired" });
        await context.db.insert("messages", {
            message: { content: "secret question", role: "user" },
            order: 0,
            status: "success",
            stepOrder: 0,
            text: "secret question",
            threadId,
            tool: false,
            userId: OWNER,
        });
        await context.db.insert("files", { chatId: threadId, key: "k-owner", name: "a.png", organizationId: ORG, size: 1, type: "image/png", userId: OWNER });
        await context.db.insert("files", { key: "k-stranger", name: "b.png", size: 1, type: "image/png", userId: STRANGER });

        return threadId;
    });

const withHarness = async (test: (harness: ReturnType<typeof lunoraTest>, threadId: string) => Promise<void>) => {
    const harness = lunoraTest(schema as never);

    try {
        await test(harness, await seed(harness));
    } finally {
        harness.close();
    }
};

const as = (harness: ReturnType<typeof lunoraTest>, userId: string) => harness.withIdentity({ userId });

describe("resolveThreadReadAccess", () => {
    it("is full for the owner and live grantees, redacted for a stranger or an expired grant", async () => {
        await withHarness(async (harness, threadId) => {
            const kinds = await harness.run(async (context: any) => {
                const result: Record<string, unknown> = {};

                for (const userId of [OWNER, GRANTEE, WRITER, "user-expired", STRANGER, undefined]) {
                    const access = await resolveThreadReadAccess(context, threadId as never, userId);

                    result[userId ?? "anonymous"] = access && (access.kind === "full" ? access.permission : access.kind);
                }

                return result;
            });

            expect(kinds).toEqual({
                anonymous: "redacted",
                [GRANTEE]: "read",
                [OWNER]: "admin",
                [STRANGER]: "redacted",
                "user-expired": "redacted",
                [WRITER]: "write",
            });
        });
    });
});

describe("former public fast paths", () => {
    it("checkThreadAccessBatchHandler and getThreadWithAccess give a stranger nothing", async () => {
        await withHarness(async (harness, threadId) => {
            const batch = await harness.run(async (context: any) => checkThreadAccessBatchHandler(context, { threadId: threadId as never, userId: STRANGER }));
            const owner = await harness.run(async (context: any) => checkThreadAccessBatchHandler(context, { threadId: threadId as never, userId: OWNER }));

            expect(batch).toEqual({ hasAccess: false, permission: null, thread: null });
            expect(owner).toMatchObject({ hasAccess: true, permission: "admin", thread: { customSystemPrompt: SECRET_PROMPT } });

            const withAccess = async (userId?: string) =>
                await harness.run(async (context: any) => await context.runQuery(getThreadWithAccess, userId ? { threadId, userId } : { threadId }));

            expect(await withAccess(STRANGER)).toBeNull();
            expect(await withAccess()).toBeNull();
            expect(await withAccess(GRANTEE)).toMatchObject({ userId: OWNER });
        });
    });

    it("getThreadAccess (grantee e-mails) refuses a stranger", async () => {
        await withHarness(async (harness, threadId) => {
            await expect(as(harness, STRANGER).query(getThreadAccess as never, { threadId } as never)).rejects.toThrow();
        });
    });

    it("listMessagesByThreadId gives a stranger an empty page and the grantee the rows", async () => {
        await withHarness(async (harness, threadId) => {
            const args = { order: "asc", threadId } as never;
            const stranger: any = await as(harness, STRANGER).query(listMessagesByThreadId as never, args);
            const grantee: any = await as(harness, GRANTEE).query(listMessagesByThreadId as never, args);

            expect(stranger.page).toEqual([]);
            expect(grantee.page).toHaveLength(1);
        });
    });

    it("chat_functions.getThread, getThreadUIMessages and getThreadWithData redact for a stranger", async () => {
        await withHarness(async (harness, threadId) => {
            const paginationOptions = { cursor: null, numItems: 10 };

            const thread: any = await as(harness, STRANGER).query(getThread as never, { threadId } as never);
            const messages: any = await as(harness, STRANGER).query(getThreadUIMessages as never, { paginationOpts: paginationOptions, threadId } as never);
            const composite: any = await as(harness, STRANGER).query(getThreadWithData as never, { threadId } as never);

            for (const redacted of [thread, composite.thread]) {
                expect(redacted).toMatchObject({ _id: threadId, isPublic: true, publicAccessToken: "share-token" });
                expect(redacted).not.toHaveProperty("userId");
                expect(redacted).not.toHaveProperty("customSystemPrompt");
            }

            for (const page of [messages.page, composite.messages.page]) {
                expect(page).toHaveLength(1);
                expect(page[0]).not.toHaveProperty("userId");
            }

            expect(composite.permission).toBe("read");

            const owner: any = await as(harness, OWNER).query(getThreadWithData as never, { threadId } as never);

            expect(owner).toMatchObject({ permission: "admin", thread: { customSystemPrompt: SECRET_PROMPT, userId: OWNER } });
        });
    });
});

describe("vault", () => {
    it("getAttachmentsForChat denies a member of the chat's organization and allows owner and grantee", async () => {
        await withHarness(async (harness, threadId) => {
            await expect(as(harness, STRANGER).query(getAttachmentsForChat as never, { chatId: threadId } as never)).rejects.toThrow();
            expect(await as(harness, OWNER).query(getAttachmentsForChat as never, { chatId: threadId } as never)).toHaveLength(1);
            expect(await as(harness, GRANTEE).query(getAttachmentsForChat as never, { chatId: threadId } as never)).toHaveLength(1);
        });
    });
});
