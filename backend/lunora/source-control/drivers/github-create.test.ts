/**
 * Opening a pull request through the GitHub driver: the one write the coding-agent
 * path makes, on the host adapter's own shapes (identified by `owner/name`, answered
 * with the host's web page). Recorded responses, not live GitHub.
 */
import { describe, expect, it } from "vitest";

import { HostApiError } from "../origin-fetch";
import type { HostRequest, HostRequestOptions } from "../origin-fetch";
import { GITHUB_CAPABILITIES, githubDriver } from "./github";

const BASE = "main";
const BODY = "The change and what to check.";
const HEAD = "neore/agent-abc123";
const REPO = "octo/hello";
const TITLE = "Coding agent: fix the flake";

/** The driver declares the write; a driver that did not would read as unsupported, which the capability test covers. */
const createPullRequest = githubDriver.createPullRequest ?? (() => Promise.reject(new Error("the driver declares no createPullRequest")));

interface Sent {
    json: any;
    method: string;
    path: string;
}

/** A host that answers by exact path; a path nobody declared is a 404, as at the host. */
const host = (routes: Record<string, unknown | HostApiError | ((sent: Sent) => unknown)>) => {
    const sent: Sent[] = [];
    const request: HostRequest = async (path, options: HostRequestOptions = {}) => {
        const call = { json: options.json, method: options.method ?? "GET", path };

        sent.push(call);

        const route = routes[path];

        if (route === undefined) {
            throw new HostApiError(`no route ${path}`, 404);
        }

        const body = typeof route === "function" ? (route as (call: Sent) => unknown)(call) : route;

        if (body instanceof HostApiError) {
            throw body;
        }

        return Response.json(body);
    };

    return { request, sent };
};

describe("github driver createPullRequest", () => {
    it("is a native capability, declared on the driver", () => {
        expect(githubDriver.createPullRequest).toBeTypeOf("function");
        expect(GITHUB_CAPABILITIES.groups.pullRequest?.create).toMatchObject({ degradation: "none", supported: true });
    });

    it("opens the pull request with the base, body, head and title, and keeps the web page the host gave", async () => {
        const { request, sent } = host({
            "/repos/octo/hello/pulls": () => {
                return { html_url: `https://github.com/${REPO}/pull/9`, number: 9 };
            },
        });

        const result = await createPullRequest(request, { base: BASE, body: BODY, head: HEAD, repository: REPO, title: TITLE });

        expect(result).toEqual({ url: `https://github.com/${REPO}/pull/9` });
        expect(sent).toEqual([
            {
                json: { base: BASE, body: BODY, head: HEAD, title: TITLE },
                method: "POST",
                path: "/repos/octo/hello/pulls",
            },
        ]);
    });

    it("builds the web page itself when the host answers without one it owns", async () => {
        const { request } = host({
            "/repos/octo/hello/pulls": () => {
                return { html_url: "https://example.com/somewhere-else", number: 4 };
            },
        });

        const result = await createPullRequest(request, { base: BASE, body: BODY, head: HEAD, repository: REPO, title: TITLE });

        expect(result).toEqual({ url: `https://github.com/${REPO}/pull/4` });
    });

    it("refuses an address that is not owner/name", async () => {
        const { request, sent } = host({});

        await expect(createPullRequest(request, { base: BASE, body: BODY, head: HEAD, repository: "gitlab:octo/hello", title: TITLE })).rejects.toMatchObject({
            name: "HostApiError",
            status: 404,
        });
        expect(sent).toEqual([]);
    });

    it("refuses a branch that is not a safe web path", async () => {
        const { request, sent } = host({});

        await expect(createPullRequest(request, { base: BASE, body: BODY, head: "../evil", repository: REPO, title: TITLE })).rejects.toBeInstanceOf(
            HostApiError,
        );
        expect(sent).toEqual([]);
    });

    it("keeps the host's own reason for a refusal, from the bound requester", async () => {
        const { request } = host({
            "/repos/octo/hello/pulls": () => new HostApiError(" pull request address refused", 422),
        });

        await expect(createPullRequest(request, { base: BASE, body: BODY, head: HEAD, repository: REPO, title: TITLE })).rejects.toMatchObject({
            name: "HostApiError",
            status: 422,
        });
    });

    it("never announces the pull request when the 2xx body cannot be read (it may exist: the answer stays unconfirmed)", async () => {
        const { request } = host({
            "/repos/octo/hello/pulls": () => {
                return { went: "somewhere" };
            },
        });

        await expect(createPullRequest(request, { base: BASE, body: BODY, head: HEAD, repository: REPO, title: TITLE })).rejects.toMatchObject({
            name: "HostApiError",
            status: 0,
            unconfirmed: true,
        });
    });
});
