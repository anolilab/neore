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

const { listFeedback } = await import("./admin");

type Page = {
    continueCursor: string | null;
    isDone: boolean;
    page: {
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

    it("pages through every row without repeats", async () => {
        for (let index = 0; index < 7; index += 1) {
            await insertFeedback(memberId, index, "idea");
        }

        const seen: number[] = [];
        let cursor: string | null = null;

        for (let guard = 0; guard < 10; guard += 1) {
            const result: Page = await list({ cursor, limit: 3 });

            seen.push(...result.page.map((row) => row.createdAt));

            if (result.isDone) {
                break;
            }

            cursor = result.continueCursor;
        }

        expect(seen).toEqual([6, 5, 4, 3, 2, 1, 0]);
    });

    it("never returns an image's storage key", async () => {
        await insertFeedback(memberId, 1, "problem", [`feedback/${memberId}/secret-key`]);

        const { page } = await list({});
        const [image] = page[0]?.images ?? [];

        expect(image?.contentType).toBe("image/png");
        expect(image).not.toHaveProperty("key");
        // The harness has no storage bound, so nothing can be signed: the image is listed without a URL.
        expect(image?.url).toBeNull();
    });
});
