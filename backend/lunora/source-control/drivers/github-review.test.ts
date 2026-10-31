/**
 * The GitHub driver's review half against recorded response shapes (REST reviews and
 * replies, GraphQL review threads, viewed state and the mutations), not live GitHub.
 */
import { describe, expect, it } from "vitest";

import { HostApiError } from "../origin-fetch";
import type { HostRequest, HostRequestOptions } from "../origin-fetch";
import type { ReviewSubmission } from "../types";
import { githubDriver } from "./github";

const REF = { number: 7, repository: "octo/hello" };
const SHA = "a".repeat(40);

interface Sent {
    json: any;
    method: string;
    path: string;
}

/** A host that answers by path (REST) or by the GraphQL operation named in the query text. */
const host = (answer: (sent: Sent) => unknown) => {
    const sent: Sent[] = [];
    const request: HostRequest = async (path, options: HostRequestOptions = {}) => {
        const call = { json: options.json, method: options.method ?? "GET", path };

        sent.push(call);

        const body = answer(call);

        if (body instanceof HostApiError) {
            throw body;
        }

        return Response.json(body);
    };

    return { request, sent };
};

const SUBMISSION: ReviewSubmission = {
    body: "Two nits",
    comments: [
        { body: "rename", line: 12, path: "src/a.ts", side: "new", startLine: null },
        { body: "dead code", line: 30, path: "src/b.ts", side: "old", startLine: 28 },
    ],
    commitId: SHA,
    verdict: "request_changes",
};

describe("submitReview", () => {
    it("is ONE review call carrying every comment, the verdict and the commit", async () => {
        const { request, sent } = host(() => {
            return { html_url: "https://github.com/octo/hello/pull/7#pullrequestreview-99", id: 99, state: "CHANGES_REQUESTED" };
        });

        expect(await githubDriver.submitReview(request, REF, SUBMISSION)).toEqual({
            id: "99",
            url: "https://github.com/octo/hello/pull/7#pullrequestreview-99",
        });
        expect(sent).toHaveLength(1);
        expect(sent[0]).toEqual({
            json: {
                body: "Two nits",
                comments: [
                    { body: "rename", line: 12, path: "src/a.ts", side: "RIGHT" },
                    { body: "dead code", line: 30, path: "src/b.ts", side: "LEFT", start_line: 28, start_side: "LEFT" },
                ],
                commit_id: SHA,
                event: "REQUEST_CHANGES",
            },
            method: "POST",
            path: "/repos/octo/hello/pulls/7/reviews",
        });
    });

    it.each([
        ["approve", "APPROVE"],
        ["comment", "COMMENT"],
        ["request_changes", "REQUEST_CHANGES"],
    ] as const)("sends the %s verdict as %s", async (verdict, event) => {
        const { request, sent } = host(() => {
            return { id: 1, state: "APPROVED" };
        });

        await githubDriver.submitReview(request, REF, { ...SUBMISSION, comments: [], verdict });

        expect(sent[0]?.json.event).toBe(event);
    });

    it("does not call the host for an address or commit that is not one", async () => {
        const { request, sent } = host(() => {
            return { id: 1, state: "APPROVED" };
        });

        await expect(githubDriver.submitReview(request, { number: 1, repository: "../x" }, SUBMISSION)).rejects.toMatchObject({ status: 404 });
        await expect(githubDriver.submitReview(request, REF, { ...SUBMISSION, commitId: "main" })).rejects.toMatchObject({ status: 404 });
        expect(sent).toEqual([]);
    });

    it("lets a refusal through, with the host's reason on it", async () => {
        const { request } = host(() => new HostApiError("x", 422, false, { detail: "Can not approve your own pull request" }));

        await expect(githubDriver.submitReview(request, REF, SUBMISSION)).rejects.toMatchObject({
            detail: "Can not approve your own pull request",
            status: 422,
        });
    });

    it("calls an answer it cannot read, or a review left pending, unconfirmed: the host may have it", async () => {
        const unreadable = host(() => {
            return { surprise: true };
        });
        const pending = host(() => {
            return { id: 3, state: "PENDING" };
        });

        await expect(githubDriver.submitReview(unreadable.request, REF, SUBMISSION)).rejects.toMatchObject({ unconfirmed: true });
        await expect(githubDriver.submitReview(pending.request, REF, SUBMISSION)).rejects.toMatchObject({ unconfirmed: true });
    });
});

describe("review threads", () => {
    const threadNode = (overrides: Record<string, unknown> = {}) => {
        return {
            comments: {
                nodes: [
                    { author: { login: "reviewer" }, body: "Why?", createdAt: "2026-10-02T10:00:00Z", fullDatabaseId: "1001" },
                    { author: null, body: "Because.", createdAt: "2026-10-02T11:00:00Z", fullDatabaseId: 1002 },
                    { author: { login: "x" }, body: "bad id", createdAt: "2026-10-02T11:00:00Z", fullDatabaseId: "not-a-number" },
                ],
            },
            diffSide: "LEFT",
            id: "PRRT_kwDOA",
            isOutdated: false,
            isResolved: false,
            line: 12,
            path: "src/a.ts",
            startLine: null,
            viewerCanResolve: true,
            viewerCanUnresolve: false,
            ...overrides,
        };
    };

    it("lists threads with their comments in host-neutral shape, one page at a time", async () => {
        const { request, sent } = host(() => {
            return {
                data: {
                    repository: {
                        pullRequest: { reviewThreads: { nodes: [threadNode(), { broken: true }], pageInfo: { endCursor: "abc", hasNextPage: true } } },
                    },
                },
            };
        });
        const page = await githubDriver.listThreads(request, REF, "prev");

        expect(page).toEqual({
            endCursor: "abc",
            hasMore: true,
            items: [
                {
                    canResolve: true,
                    canUnresolve: false,
                    comments: [
                        { authorLogin: "reviewer", body: "Why?", createdAt: Date.parse("2026-10-02T10:00:00Z"), id: "1001" },
                        { authorLogin: "ghost", body: "Because.", createdAt: Date.parse("2026-10-02T11:00:00Z"), id: "1002" },
                    ],
                    id: "PRRT_kwDOA",
                    isOutdated: false,
                    isResolved: false,
                    line: 12,
                    path: "src/a.ts",
                    side: "old",
                    startLine: null,
                },
            ],
        });
        expect(sent[0]?.json.variables).toEqual({ after: "prev", name: "hello", number: 7, owner: "octo" });
        // The text of a query is a constant: nothing the caller sent is spliced into it.
        expect(sent[0]?.json.query).not.toContain("octo");
    });

    it("reads on through a long thread past its first page of comments", async () => {
        const comment = (id: number) => {
            return { author: { login: "r" }, body: `c${id}`, createdAt: "2026-10-02T10:00:00Z", fullDatabaseId: String(id) };
        };
        const { request, sent } = host((call) => {
            if (call.json.query.includes("node(id")) {
                return { data: { node: { comments: { nodes: [comment(31)], pageInfo: { endCursor: null, hasNextPage: false } } } } };
            }

            return {
                data: {
                    repository: {
                        pullRequest: {
                            reviewThreads: {
                                nodes: [threadNode({ comments: { nodes: [comment(30)], pageInfo: { endCursor: "c30", hasNextPage: true } } })],
                                pageInfo: { endCursor: null, hasNextPage: false },
                            },
                        },
                    },
                },
            };
        });
        const page = await githubDriver.listThreads(request, REF, null);

        expect(page.items[0]?.comments.map((entry) => entry.id)).toEqual(["30", "31"]);
        expect(sent[1]?.json.variables).toEqual({ after: "c30", id: "PRRT_kwDOA" });
    });

    it("says a pull request that is not there is not found", async () => {
        const { request } = host(() => {
            return { data: { repository: { pullRequest: null } } };
        });

        await expect(githubDriver.listThreads(request, REF, null)).rejects.toMatchObject({ status: 404 });
    });
});

describe("replies and resolving", () => {
    it("replies to a comment of the thread at once, and returns the new comment's id", async () => {
        const { request, sent } = host(() => {
            return { id: 555 };
        });

        expect(await githubDriver.replyToThread(request, REF, "1001", "Fixed")).toEqual({ id: "555" });
        expect(sent).toEqual([{ json: { body: "Fixed" }, method: "POST", path: "/repos/octo/hello/pulls/7/comments/1001/replies" }]);
    });

    it("calls a reply answer it cannot read unconfirmed: the host has the reply, and a retry would post it twice", async () => {
        const { request } = host(() => {
            return { surprise: true };
        });

        await expect(githubDriver.replyToThread(request, REF, "1001", "Fixed")).rejects.toMatchObject({ unconfirmed: true });
    });

    it("sends nothing for a comment id that is not a number", async () => {
        const { request, sent } = host(() => {
            return { id: 1 };
        });

        await expect(githubDriver.replyToThread(request, REF, "1001/../../x", "hi")).rejects.toMatchObject({ status: 404 });
        expect(sent).toEqual([]);
    });

    it.each([true, false])("sets a thread resolved=%s and checks the host's answer", async (resolved) => {
        const { request, sent } = host((call) => {
            const name = call.json.query.includes("unresolveReviewThread") ? "unresolveReviewThread" : "resolveReviewThread";

            return { data: { [name]: { thread: { id: "T", isResolved: name === "resolveReviewThread" } } } };
        });

        await githubDriver.setThreadResolved(request, "PRRT_kwDOA", resolved);

        expect(sent[0]?.json.variables).toEqual({ threadId: "PRRT_kwDOA" });
        expect(sent[0]?.json.query).toContain(resolved ? "resolveReviewThread" : "unresolveReviewThread");
    });

    it("does not call a change done when the host answers with the old state", async () => {
        const { request } = host(() => {
            return { data: { resolveReviewThread: { thread: { id: "T", isResolved: false } } } };
        });

        await expect(githubDriver.setThreadResolved(request, "PRRT_kwDOA", true)).rejects.toBeInstanceOf(HostApiError);
    });

    it("refuses a thread id that is not an id before any call", async () => {
        const { request, sent } = host(() => {
            return {};
        });

        await expect(githubDriver.setThreadResolved(request, "x } mutation { evil", true)).rejects.toMatchObject({ status: 404 });
        expect(sent).toEqual([]);
    });
});

/** A pull request whose files GitHub tracks per viewer, behind the GraphQL operations the driver uses. */
const viewedHost = (initial: Record<string, string>) => {
    const state = { ...initial };
    const { request, sent } = host((call) => {
        const { query, variables } = call.json as { query: string; variables: Record<string, any> };

        if (query.includes("mutation") && !query.includes("unmark")) {
            state[variables.path] = "VIEWED";

            return { data: { markFileAsViewed: { clientMutationId: null } } };
        }

        if (query.includes("unmarkFileAsViewed")) {
            state[variables.path] = "UNVIEWED";

            return { data: { unmarkFileAsViewed: { clientMutationId: null } } };
        }

        if (query.includes("files(")) {
            const nodes = Object.entries(state).map(([path, viewerViewedState]) => {
                return { path, viewerViewedState };
            });

            return { data: { repository: { pullRequest: { files: { nodes, pageInfo: { endCursor: null, hasNextPage: false } } } } } };
        }

        return { data: { repository: { pullRequest: { id: "PR_node" } } } };
    });

    return { request, sent, state };
};

describe("viewed marks", () => {
    it("round-trips: a mark made here is on the host, and the host's state reads back", async () => {
        const { request, sent, state } = viewedHost({ "a.ts": "UNVIEWED", "b.ts": "DISMISSED", "c.ts": "VIEWED" });

        await githubDriver.setViewed(request, REF, "a.ts", true);

        expect(state["a.ts"]).toBe("VIEWED");
        expect(sent.find((call) => call.json.query.includes("mutation"))?.json.variables).toEqual({ path: "a.ts", pullRequestId: "PR_node" });

        const page = await githubDriver.listViewed(request, REF, null);

        expect(page.items).toEqual([
            { path: "a.ts", state: "viewed" },
            { path: "b.ts", state: "changed" },
            { path: "c.ts", state: "viewed" },
        ]);

        await githubDriver.setViewed(request, REF, "a.ts", false);

        const { items } = await githubDriver.listViewed(request, REF, null);

        expect(items[0]).toEqual({ path: "a.ts", state: "unviewed" });
    });

    it("reports a failed mutation as a failure, not as marked", async () => {
        const failing = host((call) =>
            call.json.query.includes("mutation")
                ? { errors: [{ message: "no", type: "FORBIDDEN" }] }
                : { data: { repository: { pullRequest: { id: "PR_node" } } } },
        );

        await expect(githubDriver.setViewed(failing.request, REF, "a.ts", true)).rejects.toMatchObject({ status: 403 });
    });

    it("does not take a null or empty answer to the mutation for success", async () => {
        for (const data of [null, {}]) {
            const odd = host((call) => (call.json.query.includes("mutation") ? { data } : { data: { repository: { pullRequest: { id: "PR_node" } } } }));

            await expect(githubDriver.setViewed(odd.request, REF, "a.ts", true)).rejects.toBeDefined();
        }
    });
});
