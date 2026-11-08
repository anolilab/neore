/**
 * The pull request actions refuse a request the host would refuse (or a host that does not offer the action) before any
 * token is read or host call is made.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import schema from "../schema";
import { editPullRequest, requestReviewers, revertPullRequest } from "./pull-request-actions";

const { capable, resolveToken, sessionFrom } = vi.hoisted(() => {
    return {
        capable: { value: true },
        resolveToken: vi.fn(async () => {
            return { problem: "not_connected" };
        }),
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
    return { ...(await importOriginal<typeof import("../connectors/lib/github-token")>()), resolveGithubToken: resolveToken };
});

vi.mock("./capabilities", async (importOriginal) => {
    return { ...(await importOriginal<typeof import("./capabilities")>()), isHostCapabilityAvailable: () => capable.value };
});

const PULL = { number: 7, repository: "octo/hello" };

let harness: ReturnType<typeof lunoraTest>;

beforeEach(() => {
    capable.value = true;
    resolveToken.mockClear();
    harness = lunoraTest(schema as never);
});

afterEach(() => {
    harness.close();
});

const call = async (procedure: unknown, args: object): Promise<unknown> =>
    await harness.withIdentity({ userId: "user-a" }).action(procedure as never, { ...PULL, ...args } as never);

describe("pull request actions refuse before reading a token", () => {
    it("when the host does not offer the action", async () => {
        capable.value = false;

        await expect(call(editPullRequest, { title: "New" })).rejects.toThrow("This host does not offer that");
        await expect(call(requestReviewers, { logins: ["octocat"] })).rejects.toThrow("This host does not offer that");
        await expect(call(revertPullRequest, {})).rejects.toThrow("This host does not offer that");
        expect(resolveToken).not.toHaveBeenCalled();
    });

    it("an edit that changes nothing", async () => {
        await expect(call(editPullRequest, {})).rejects.toThrow("Nothing to change");
        await expect(call(editPullRequest, { title: " ".repeat(3) })).rejects.toThrow("A title cannot be empty");
        await expect(call(editPullRequest, { title: "x".repeat(257) })).rejects.toThrow("at most 256 characters");
        await expect(call(revertPullRequest, { title: " ".repeat(3) })).rejects.toThrow("A title cannot be empty");
        expect(resolveToken).not.toHaveBeenCalled();
    });

    it("a reviewer list that is empty or longer than one call may add", async () => {
        await expect(call(requestReviewers, { logins: [] })).rejects.toThrow("between 1 and 15");
        await expect(call(requestReviewers, { logins: Array.from({ length: 16 }, (_, index) => `user${index}`) })).rejects.toThrow("between 1 and 15");
        expect(resolveToken).not.toHaveBeenCalled();
    });

    it("a login that is not one, naming the first bad one", async () => {
        await expect(call(requestReviewers, { logins: ["octocat", "bad login", "-also-bad"] })).rejects.toThrow('"bad login" is not a valid login');
        // A managed user's login has single underscores; a trailing or doubled one is not a login.
        await expect(call(requestReviewers, { logins: ["dana_acme", "dana_"] })).rejects.toThrow('"dana_" is not a valid login');
        await expect(call(requestReviewers, { logins: ["a__b"] })).rejects.toThrow('"a__b" is not a valid login');
        expect(resolveToken).not.toHaveBeenCalled();
    });
});

describe("a valid request", () => {
    it("reads the token and reports a missing connection instead of calling the host", async () => {
        await expect(call(requestReviewers, { logins: ["octocat"] })).resolves.toMatchObject({ status: "not_connected" });
        expect(resolveToken).toHaveBeenCalledTimes(1);
    });

    it("lets a full-length title with trailing spaces through, since it is sent trimmed", async () => {
        await expect(call(editPullRequest, { title: `${"x".repeat(256)}  ` })).resolves.toMatchObject({ status: "not_connected" });
    });
});
