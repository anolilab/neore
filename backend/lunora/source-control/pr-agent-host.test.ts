/**
 * The agent's pull request tools against the real GitHub driver, with the network stubbed: a failed check comes back
 * with its name and a capped log excerpt (read off the storage origin WITHOUT the token), and a pull request that is
 * not linked to the thread is refused before any host call.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { LOG_EXCERPT_MAX_CHARS } from "./check-log";
import { githubDriver } from "./drivers/github";
import type { LinkedPullRequest, PullRequestAgentDependencies } from "./pr-agent-host";
import { mergeForAgent, pickLinkedPullRequest, readFailingChecksForAgent, readPullRequestForAgent, rerunFailedForAgent } from "./pr-agent-host";

const SHA = "b".repeat(40);
const API = "https://api.github.com/repos/octo/hello";
// Built from parts: a storage account address written out reads as a credential to the secret scanner.
const STORAGE = ["productionresultssa1", "blob", "core", "windows", "net"].join(".");
const LOG_URL = `https://${STORAGE}/actions-results/job-11?sig=abc`;
const TOKEN = "token-1";

const pull = {
    additions: 1,
    base: { ref: "main" },
    body: "Adds sum()",
    changed_files: 1,
    commits: 1,
    created_at: "2026-11-01T00:00:00Z",
    deletions: 0,
    head: { ref: "feat/sum", sha: SHA },
    html_url: "https://github.com/octo/hello/pull/7",
    number: 7,
    state: "open",
    title: "Add sum",
    updated_at: "2026-11-02T00:00:00Z",
    user: { login: "octocat" },
};

interface Seen {
    authorization: string | null;
    method: string;
    url: string;
}

const stubHost = (routes: Record<string, () => Response>) => {
    const seen: Seen[] = [];

    vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
            const url = new URL(input instanceof Request ? input.url : String(input));
            const key = `${init.method ?? "GET"} ${url.origin}${url.pathname}`;

            seen.push({ authorization: new Headers(init.headers).get("authorization"), method: init.method ?? "GET", url: url.href });

            const route = routes[key];

            return route ? route() : Response.json({ message: "Not Found" }, { status: 404 });
        }),
    );

    return seen;
};

const LINKED: LinkedPullRequest[] = [{ kind: "linked", number: 7, repository: "octo/hello" }];

const dependencies = (linked: LinkedPullRequest[] = LINKED): PullRequestAgentDependencies => {
    return {
        driver: githubDriver,
        linked: async () => linked,
        token: async () => {
            return {
                accessToken: TOKEN,
                renew: async () => {
                    return { problem: "expired" };
                },
            };
        },
    };
};

const longLog = [
    ...Array.from({ length: 3000 }, (_, index) => `2026-11-06T10:00:00.0000000Z step output line ${String(index)} ${"z".repeat(40)}`),
    "2026-11-06T10:00:01.0000000Z FAIL src/sum.test.ts > adds",
    "2026-11-06T10:00:01.0000000Z ##[error]Process completed with exit code 1.",
].join("\n");

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("reading the failing checks of a linked pull request", () => {
    it("returns the failed check's name and a log excerpt under the cap, and never sends the token to the log's origin", async () => {
        const seen = stubHost({
            [`GET ${API}/actions/jobs/11/logs`]: () => new Response(null, { headers: { location: LOG_URL }, status: 302 }),
            [`GET ${API}/check-runs/11`]: () => Response.json({ app: { slug: "github-actions" }, id: 11, name: "test", output: null }),
            [`GET ${API}/commits/${SHA}/check-runs`]: () =>
                Response.json({
                    check_runs: [
                        {
                            app: { slug: "github-actions" },
                            conclusion: "failure",
                            html_url: "https://github.com/octo/hello/runs/11",
                            id: 11,
                            name: "test",
                            status: "completed",
                        },
                        {
                            app: { slug: "github-actions" },
                            conclusion: "success",
                            html_url: "https://github.com/octo/hello/runs/12",
                            id: 12,
                            name: "lint",
                            status: "completed",
                        },
                    ],
                    total_count: 2,
                }),
            [`GET ${API}/commits/${SHA}/status`]: () => Response.json({ statuses: [], total_count: 0 }),
            [`GET ${API}/pulls/7`]: () => Response.json(pull),
            [`GET https://${STORAGE}/actions-results/job-11`]: () => new Response(longLog),
        });

        const outcome = await readFailingChecksForAgent(dependencies(), {});

        expect(outcome.status).toBe("ok");

        if (outcome.status !== "ok" || !("checks" in outcome)) {
            throw new Error("expected checks");
        }

        expect(outcome.checks.map((check) => check.name)).toStrictEqual(["test"]);
        expect(outcome.passing).toBe(1);

        const [failed] = outcome.checks;

        expect(failed?.log?.source).toBe("job_log");
        expect(failed?.log?.excerpt).toContain("FAIL src/sum.test.ts > adds");
        expect(failed?.log?.excerpt.length).toBeLessThanOrEqual(LOG_EXCERPT_MAX_CHARS);
        expect(failed?.log?.truncated).toBe(true);

        const logRead = seen.find((call) => call.url.startsWith(`https://${STORAGE}/`));

        expect(logRead?.authorization).toBeNull();
        expect(seen.filter((call) => call.url.startsWith("https://api.github.com/")).every((call) => call.authorization === `Bearer ${TOKEN}`)).toBe(true);
    });

    it("does not follow a log redirect to an origin that is not the host's storage", async () => {
        const seen = stubHost({
            [`GET ${API}/actions/jobs/11/logs`]: () => new Response(null, { headers: { location: "https://evil.example/log" }, status: 302 }),
            [`GET ${API}/check-runs/11`]: () =>
                Response.json({ app: { slug: "github-actions" }, id: 11, name: "test", output: { summary: "1 test failed", text: null, title: "Tests" } }),
            [`GET ${API}/commits/${SHA}/check-runs`]: () =>
                Response.json({
                    check_runs: [{ app: { slug: "github-actions" }, conclusion: "failure", id: 11, name: "test", status: "completed" }],
                    total_count: 1,
                }),
            [`GET ${API}/commits/${SHA}/status`]: () => Response.json({ statuses: [], total_count: 0 }),
            [`GET ${API}/pulls/7`]: () => Response.json(pull),
        });

        const outcome = await readFailingChecksForAgent(dependencies(), {});

        expect(seen.some((call) => call.url.startsWith("https://evil.example"))).toBe(false);
        expect(outcome.status === "ok" && "checks" in outcome && outcome.checks[0]?.log).toStrictEqual({
            excerpt: "Tests\n\n1 test failed",
            source: "check_output",
            truncated: false,
        });
    });
});

describe("a pull request that is not linked to the thread", () => {
    it("is refused before the host is asked anything, for reads and writes alike", async () => {
        const seen = stubHost({});
        const other = { number: 8, repository: "octo/hello" };

        await expect(readPullRequestForAgent(dependencies(), other)).resolves.toMatchObject({ status: "not_linked" });
        await expect(readFailingChecksForAgent(dependencies(), { number: 7, repository: "octo/other" })).resolves.toMatchObject({ status: "not_linked" });
        await expect(rerunFailedForAgent(dependencies(), other, undefined)).resolves.toMatchObject({ status: "not_linked" });
        await expect(mergeForAgent(dependencies(), other, SHA, "squash")).resolves.toMatchObject({ status: "not_linked" });
        await expect(readPullRequestForAgent(dependencies([]), {})).resolves.toMatchObject({ status: "none_linked" });
        expect(seen).toHaveLength(0);
    });
});

describe(pickLinkedPullRequest, () => {
    const two: LinkedPullRequest[] = [...LINKED, { kind: "opened", number: 9, repository: "octo/hello" }];

    it("takes the only link when none is named, and asks to choose among several", () => {
        expect(pickLinkedPullRequest(LINKED, {})).toStrictEqual({ ref: { number: 7, repository: "octo/hello" }, status: "ok" });
        expect(pickLinkedPullRequest(two, {}).status).toBe("choose");
    });

    it("matches the repository however it is cased", () => {
        expect(pickLinkedPullRequest(two, { number: 9, repository: "Octo/Hello" })).toStrictEqual({
            ref: { number: 9, repository: "octo/hello" },
            status: "ok",
        });
    });

    it("refuses an address that is not one", () => {
        expect(pickLinkedPullRequest(two, { number: 9, repository: "../etc" }).status).toBe("not_linked");
        expect(pickLinkedPullRequest(two, { number: -1, repository: "octo/hello" }).status).toBe("not_linked");
    });
});

describe("merging a linked pull request", () => {
    it("refuses a head the pull request has moved past, without a merge call", async () => {
        const seen = stubHost({
            [`GET ${API}/pulls/7`]: () => Response.json({ ...pull, mergeable_state: "clean" }),
            [`GET ${API}`]: () => Response.json({ allow_squash_merge: true }),
        });

        await expect(mergeForAgent(dependencies(), {}, "c".repeat(40), undefined)).resolves.toMatchObject({ status: "head_moved" });
        expect(seen.some((call) => call.method === "PUT")).toBe(false);
    });

    it("merges the named head with the repository's allowed method", async () => {
        const seen = stubHost({
            [`GET ${API}/pulls/7`]: () => Response.json({ ...pull, mergeable_state: "clean" }),
            [`GET ${API}`]: () => Response.json({ allow_merge_commit: false, allow_squash_merge: true }),
            [`PUT ${API}/pulls/7/merge`]: () => Response.json({ merged: true, sha: "d".repeat(40) }),
        });

        expect(await mergeForAgent(dependencies(), {}, SHA, undefined)).toStrictEqual({ sha: "d".repeat(40), status: "ok" });
        expect(seen.filter((call) => call.method === "PUT")).toHaveLength(1);
    });
});
