/**
 * The admins' feedback list: refused to anyone but a platform admin, reads every
 * user's rows past the owner-only policy, newest first, a page at a time, and
 * hands images out as signed URLs, never their keys.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import schema from "../schema";

const { admins, sessionFrom } = vi.hoisted(() => {
    const adminIds = new Set<string>();

    return {
        admins: adminIds,
        sessionFrom: async (context: { auth: { userId?: string | null } }) => {
            const { userId } = context.auth;

            return userId
                ? { activeOrganization: null, email: `${userId}@example.com`, id: userId, isAdmin: adminIds.has(userId), name: userId, userId }
                : null;
        },
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

// The harness binds no storage: signing is faked, and a key containing "unsignable" fails as a real signer can.
const trySign = vi.hoisted(() =>
    vi.fn(async (_source: unknown, key: string, expiresInSeconds: number) =>
        key.includes("unsignable") ? null : `https://files.example/${key}?exp=${String(expiresInSeconds)}`,
    ),
);

vi.mock("../lib/storage-sign", async (importOriginal) => {
    return { ...(await importOriginal<typeof import("../lib/storage-sign")>()), trySign };
});

const { listFeedback } = await import("./admin");

type Page = {
    continueCursor: string | null;
    isDone: boolean;
    page: {
        _id: string;
        createdAt: number;
        images: { contentType: string; url: string | null }[];
        kind: string;
        message: string;
        sender: { email: string | null; userId: string };
    }[];
};

let harness: ReturnType<typeof lunoraTest>;
let adminId: string;
let memberId: string;

const as = (userId: string) => harness.withIdentity({ userId } as never);

const insertUser = async (email: string): Promise<string> =>
    (await harness.run(async (ctx: any) => await ctx.db.insert("user", { createdAt: 1, email, emailVerified: true, name: email, updatedAt: 1 }))) as string;

const insertFeedback = async (userId: string, createdAt: number, kind: "idea" | "other" | "problem", imageKeys: string[] = []): Promise<void> => {
    await harness.run(async (ctx: any) => {
        await ctx.db.insert("feedback", {
            createdAt,
            images: imageKeys.map((key) => {
                return { contentType: "image/png", key, size: 10 };
            }),
            kind,
            message: `${kind} at ${String(createdAt)}`,
            userId,
        });
    });
};

const list = async (args: { cursor?: string | null; kind?: string; limit?: number }, caller = adminId): Promise<Page> =>
    (await as(caller).query(listFeedback as never, args as never)) as Page;

beforeEach(async () => {
    harness = lunoraTest(schema as never);
    admins.clear();
    adminId = await insertUser("admin@example.com");
    memberId = await insertUser("member@example.com");
    admins.add(adminId);
});

afterEach(() => {
    harness.close();
});

describe("feedback_admin.listFeedback", () => {
    it("refuses a signed-in user who is not an admin", async () => {
        await insertFeedback(memberId, 1, "idea");

        await expect(list({}, memberId)).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("refuses an anonymous caller", async () => {
        await expect(harness.query(listFeedback as never, {} as never)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    });

    it("shows an admin every user's feedback, newest first, with its sender", async () => {
        const otherId = await insertUser("other@example.com");

        await insertFeedback(memberId, 1, "idea");
        await insertFeedback(otherId, 3, "problem");
        await insertFeedback(memberId, 2, "other");

        const { page } = await list({});

        expect(page.map((row) => row.createdAt)).toEqual([3, 2, 1]);
        expect(page[0]?.sender).toMatchObject({ email: "other@example.com", userId: otherId });
        expect(page[1]?.sender).toMatchObject({ email: "member@example.com", userId: memberId });
    });

    it("filters by kind", async () => {
        await insertFeedback(memberId, 1, "idea");
        await insertFeedback(memberId, 2, "problem");
        await insertFeedback(memberId, 3, "idea");

        const { page } = await list({ kind: "idea" });

        expect(page.map((row) => [row.kind, row.createdAt])).toEqual([
            ["idea", 3],
            ["idea", 1],
        ]);
    });

    const pageAll = async (args: { kind?: string }): Promise<Page["page"]> => {
        const seen: Page["page"] = [];
        let cursor: string | null = null;

        for (let guard = 0; guard < 10; guard += 1) {
            const result: Page = await list({ ...args, cursor, limit: 3 });

            seen.push(...result.page);

            if (result.isDone) {
                return seen;
            }

            cursor = result.continueCursor;
        }

        throw new Error("paging did not finish");
    };

    it("pages through every row without repeats", async () => {
        for (let index = 0; index < 7; index += 1) {
            await insertFeedback(memberId, index, "idea");
        }

        const rows = await pageAll({});

        expect(rows.map((row) => row.createdAt)).toEqual([6, 5, 4, 3, 2, 1, 0]);
    });

    it("pages a filtered list whose rows share a time without skipping or repeating one", async () => {
        for (let index = 0; index < 8; index += 1) {
            await insertFeedback(memberId, 100, index % 2 === 0 ? "problem" : "idea");
        }

        const rows = await pageAll({ kind: "problem" });

        expect(rows).toHaveLength(4);
        expect(new Set(rows.map((row) => row._id)).size).toBe(4);
        expect(rows.every((row) => row.kind === "problem")).toBe(true);
    });

    it("signs each image for display and never returns its storage key", async () => {
        const key = `feedback/${memberId}/image-1`;

        await insertFeedback(memberId, 1, "problem", [key, `feedback/${memberId}/unsignable`]);

        const { page } = await list({});
        const [signed, unsigned] = page[0]?.images ?? [];

        expect(trySign).toHaveBeenCalledWith(expect.any(Function), key, expect.any(Number));
        expect(signed?.url).toMatch(new RegExp(String.raw`^https://files\.example/${key}\?exp=\d+$`));
        expect(signed).not.toHaveProperty("key");
        // An image that cannot be signed is still listed, without a URL, rather than failing the page.
        expect(unsigned).toEqual({ contentType: "image/png", url: null });
    });
});
