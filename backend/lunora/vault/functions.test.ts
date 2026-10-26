/**
 * `deleteAttachments` deletes audited `files` rows one at a time. In parallel the
 * audit trigger nests past its recursion limit on more than about a dozen rows and
 * the whole delete rolls back.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import schema from "../schema";
import { deleteAttachments, discardUnfiledVaultFile } from "./functions";

const { sessionFrom } = vi.hoisted(() => {
    return {
        sessionFrom: async (context: { auth: { userId?: string | null } }) =>
            context.auth.userId ? { activeOrganization: null, id: context.auth.userId, isAdmin: false, userId: context.auth.userId } : null,
    };
});

vi.mock("../lib/crpc-auth-helpers", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../lib/crpc-auth-helpers")>()),
        getSessionUser: sessionFrom,
        getSessionUserForQuery: sessionFrom,
        getSessionUserForQueryLite: sessionFrom,
    };
});

vi.mock("../lib/rate-limiter", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../lib/rate-limiter")>()),
        rateLimitGuard: async () => undefined,
    };
});

const OWNER = "user-owner";
const ROWS = 60;

let harness: ReturnType<typeof lunoraTest>;

beforeEach(() => {
    harness = lunoraTest(schema as never);
});

afterEach(() => {
    harness.close();
});

describe("deleteAttachments", () => {
    it(`deletes ${String(ROWS)} attachments in one call`, async () => {
        const ids = await harness.run(async (ctx: any) => {
            const inserted: string[] = [];

            for (let index = 0; index < ROWS; index += 1) {
                inserted.push(await ctx.db.insert("files", { chatId: "chat-1", name: `f${String(index)}`, size: 1, type: "text/plain", userId: OWNER }));
            }

            return inserted;
        });

        await harness.withIdentity({ userId: OWNER } as never).mutation(deleteAttachments as never, { attachmentIds: ids } as never);

        const remaining = await harness.run(async (ctx: any) => await Promise.all(ids.map(async (id) => await ctx.db.get(id))));

        expect(remaining.filter(Boolean)).toHaveLength(0);
    });

    it("leaves an unfiled chat-less upload alone, even when its id is requested (only chat attachments are deletable here)", async () => {
        const { orphan } = await harness.run(async (ctx: any) => {
            return { orphan: await ctx.db.insert("files", { key: "k1", name: "a.txt", size: 1, type: "text/plain", userId: OWNER }) };
        });

        await harness.withIdentity({ userId: OWNER } as never).mutation(deleteAttachments as never, { attachmentIds: [orphan] } as never);

        expect(await harness.run(async (ctx: any) => Boolean(await ctx.db.get(orphan)))).toBe(true);
    });
});

describe("discardUnfiledVaultFile", () => {
    const discard = async (fileId: string, userId = OWNER) =>
        await harness.run(async (ctx: any) => await ctx.runMutation(discardUnfiledVaultFile, { fileId, userId }));
    const exists = async (id: string) => await harness.run(async (ctx: any) => Boolean(await ctx.db.get(id)));

    it("deletes an unfiled chat-less file of the user", async () => {
        const id = await harness.run(
            async (ctx: any) => await ctx.db.insert("files", { key: "k1", name: "a.txt", size: 1, type: "text/plain", userId: OWNER }),
        );

        await discard(id);

        expect(await exists(id)).toBe(false);
    });

    it("leaves a file a knowledge file points at", async () => {
        const id = await harness.run(async (ctx: any) => {
            const fileId = await ctx.db.insert("files", { key: "k2", name: "b.txt", size: 1, type: "text/plain", userId: OWNER });

            await ctx.db.insert("knowledgeFiles", {
                createdAt: 1,
                mimeType: "text/plain",
                name: "b.txt",
                size: 1,
                status: "pending",
                userId: OWNER,
                vaultFileId: fileId,
            });

            return fileId;
        });

        await discard(id);

        expect(await exists(id)).toBe(true);
    });

    it("leaves a file held by a chat, a file in a folder, and another user's file", async () => {
        const { chat, filed, other } = await harness.run(async (ctx: any) => {
            const folderId = await ctx.db.insert("folders", { name: "f", userId: OWNER });

            return {
                chat: await ctx.db.insert("files", { chatId: "chat-1", key: "k3", name: "c.txt", size: 1, type: "text/plain", userId: OWNER }),
                filed: await ctx.db.insert("files", { folderId, key: "k4", name: "d.txt", size: 1, type: "text/plain", userId: OWNER }),
                other: await ctx.db.insert("files", { key: "k5", name: "e.txt", size: 1, type: "text/plain", userId: "user-other" }),
            };
        });

        await discard(chat);
        await discard(filed);
        await discard(other);

        expect([await exists(chat), await exists(filed), await exists(other)]).toEqual([true, true, true]);
    });

    it("does not depend on deleteAttachments' 2000-file window", async () => {
        const { target } = await harness.run(async (ctx: any) => {
            const first = await ctx.db.insert("files", { key: "k-first", name: "t.txt", size: 1, type: "text/plain", userId: OWNER });

            for (let index = 0; index < 2100; index += 1) {
                await ctx.db.insert("files", { chatId: "chat-1", name: `f${String(index)}`, size: 1, type: "text/plain", userId: OWNER });
            }

            return { target: first };
        });

        await discard(target);

        expect(await exists(target)).toBe(false);
    });
});
