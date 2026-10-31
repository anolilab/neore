/**
 * The GitHub driver's conditional poll of one repository's open pull requests: an unchanged list is ONE
 * request that costs nothing, and the user's login is read once, never on a poll that finds nothing new.
 */
import { describe, expect, it } from "vitest";

import { HostApiError } from "../origin-fetch";
import type { HostRequest, HostRequestOptions } from "../origin-fetch";
import { githubDriver, GITHUB_POLL_PAGE_SIZE } from "./github";

interface Call {
    ifNoneMatch: string | undefined;
    path: string;
    query: Record<string, number | string>;
}

const pull = (number: number, overrides: Record<string, unknown> = {}) => {
    return {
        created_at: "2026-10-01T10:00:00Z",
        draft: false,
        html_url: `https://github.com/octo/hello/pull/${number}`,
        labels: [],
        number,
        requested_reviewers: [{ login: "me" }],
        title: `Pull ${number}`,
        updated_at: "2026-10-02T10:00:00Z",
        user: { login: "alice" },
        ...overrides,
    };
};

/** A host with a current list and ETag: answers 304 to a matching `If-None-Match`, else the list. */
const fakeHost = (state: { etag: string; pulls: unknown[] }) => {
    const calls: Call[] = [];
    const request: HostRequest = async (path: string, options: HostRequestOptions = {}) => {
        calls.push({ ifNoneMatch: options.ifNoneMatch, path, query: options.query ?? {} });

        if (path === "/user") {
            return Response.json({ login: "me" });
        }

        if (options.ifNoneMatch === state.etag) {
            return new Response(null, { status: 304 });
        }

        return Response.json(state.pulls, { headers: { etag: state.etag } });
    };

    return { calls, request };
};

describe("githubDriver.pollReviewRequests", () => {
    it("reads the login once, then lists the open pull requests that ask the user for a review", async () => {
        const host = fakeHost({
            etag: 'W/"one"',
            pulls: [
                pull(1),
                pull(2, { requested_reviewers: [{ login: "someone-else" }] }),
                pull(3, { draft: true }),
                pull(4, { requested_reviewers: [{ login: "ME" }] }),
            ],
        });
        const poll = await githubDriver.pollReviewRequests(host.request, "octo/hello", { etag: null, login: null });

        expect(poll.status).toBe("changed");

        if (poll.status !== "changed") {
            return;
        }

        expect(poll.login).toBe("me");
        expect(poll.etag).toBe('W/"one"');
        // A draft is not a request yet; the login compares without case, as GitHub's own logins do.
        expect(poll.requested.map((item) => item.number)).toEqual([1, 4]);
        expect(poll.requested[0]).toMatchObject({
            authorLogin: "alice",
            repository: "octo/hello",
            title: "Pull 1",
            url: "https://github.com/octo/hello/pull/1",
        });
        expect(host.calls.map((call) => call.path)).toEqual(["/user", "/repos/octo/hello/pulls"]);
        expect(host.calls[1]!.query).toMatchObject({ per_page: GITHUB_POLL_PAGE_SIZE, sort: "updated", state: "open" });
    });

    it("costs exactly one 304 when nothing changed, and sends the stored etag", async () => {
        const host = fakeHost({ etag: 'W/"one"', pulls: [pull(1)] });
        const poll = await githubDriver.pollReviewRequests(host.request, "octo/hello", { etag: 'W/"one"', login: "me" });

        expect(poll).toEqual({ status: "not_modified" });
        expect(host.calls).toEqual([{ ifNoneMatch: 'W/"one"', path: "/repos/octo/hello/pulls", query: expect.any(Object) }]);
    });

    it("keeps the stored login when the list changed", async () => {
        const host = fakeHost({ etag: 'W/"two"', pulls: [pull(9)] });
        const poll = await githubDriver.pollReviewRequests(host.request, "octo/hello", { etag: 'W/"one"', login: "me" });

        expect(poll).toMatchObject({ etag: 'W/"two"', login: "me", status: "changed" });
        expect(host.calls).toHaveLength(1);
    });

    it("refuses an address that is not owner/name before it reaches the host", async () => {
        const host = fakeHost({ etag: "x", pulls: [] });

        await expect(githubDriver.pollReviewRequests(host.request, "../../user", { etag: null, login: "me" })).rejects.toBeInstanceOf(HostApiError);
        expect(host.calls).toHaveLength(0);
    });

    it("normalises a repository address and rejects one that is not", () => {
        expect(githubDriver.normalizeRepository(" octo/hello ")).toBe("octo/hello");
        expect(githubDriver.normalizeRepository("octo/hello/extra")).toBeNull();
        expect(githubDriver.normalizeRepository("octo")).toBeNull();
        expect(githubDriver.normalizeRepository("../x")).toBeNull();
    });
});
