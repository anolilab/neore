/**
 * The review conversation goes through `.output()`, which refuses a key it does not declare. The driver's thread carries
 * its comment total and, for a thread longer than the pages read, `commentsComplete: false`: the Develop page's read of
 * such a thread must not be refused by the output check.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import schema from "../schema";
import { getReviewThreads } from "./review-functions";

const { sessionFrom } = vi.hoisted(() => {
    return {
        sessionFrom: async (context: { auth: { userId?: string | null } }) =>
            context.auth.userId ? { activeOrganization: { id: "org-1" }, id: context.auth.userId, userId: context.auth.userId } : null,
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

vi.mock("../auth", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../auth")>()),
        getAuthUserIdentity: async (context: { auth: { userId?: string | null } }) =>
            context.auth.userId ? { subject: context.auth.userId, userId: context.auth.userId } : null,
    };
});

vi.mock("../connectors/lib/github-token", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../connectors/lib/github-token")>()),
        resolveGithubToken: async () => {
            return { accessToken: "token" };
        },
    };
});

vi.mock("./read-host", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("./read-host")>()),
        readFromHost: async () => {
            return {
                endCursor: null,
                hasMore: false,
                status: "ok",
                threads: [
                    {
                        canResolve: true,
                        canUnresolve: false,
                        commentCount: 500,
                        comments: [{ authorLogin: "a", body: "x", createdAt: 0, id: "1" }],
                        commentsComplete: false,
                        id: "t",
                        isOutdated: false,
                        isResolved: false,
                        line: 3,
                        path: "a.ts",
                        side: "new",
                        startLine: null,
                    },
                ],
            };
        },
    };
});

let harness: ReturnType<typeof lunoraTest>;

beforeEach(() => {
    harness = lunoraTest(schema as never);
});

afterEach(() => {
    harness.close();
});

describe("the review conversation read", () => {
    it("hands over a thread with its comment total and an unfinished comment read", async () => {
        const result: any = await harness
            .withIdentity({ userId: "user-a" })
            .action(getReviewThreads as never, { number: 7, repository: "octo/hello" } as never);

        expect(result).toMatchObject({ status: "ok", threads: [{ commentCount: 500, commentsComplete: false, id: "t" }] });
    });
});
