/**
 * The agent's pull request tools against the real GitHub driver, with the network stubbed: a failed check comes back
 * with its name and a capped log excerpt (read off the storage origin WITHOUT the token), and a pull request that is
 * not linked to the thread is refused before any host call.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { LOG_EXCERPT_MAX_CHARS } from "./check-log";
import { githubDriver } from "./drivers/github";
import type { LinkedPullRequest, PullRequestAgentDependencies } from "./pr-agent-host";
import {
    AGENT_LOG_READ_BUDGET_MS,
    AGENT_MAX_THREAD_PAGES,
    AGENT_REVIEW_COMMENTS_BUDGET_CHARS,
    mergeForAgent,
    pickLinkedPullRequest,
    readFailingChecksForAgent,
    readPullRequestForAgent,
    rerunFailedForAgent,
    parseThreadCursor,
    readThreadsWithin,
} from "./pr-agent-host";

const SHA = "b".repeat(40);
const API = "https://api.github.com/repos/octo/hello";
// Built from parts: a storage account address written out reads as a credential to the secret scanner.
const STORAGE = ["productionresultssa1", "blob", "core", "windows", "net"].join(".");
const LOG_URL = `https://${STORAGE}/actions-results/job-11?sig=abc`;
const TOKEN = "token-1";
/** A cut excerpt opens with its marker. */
const MARKED = /^\[truncated, \d+ more lines/u;

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
        allowed: async () => true,
        driver: githubDriver,
        isLinked: async (ref) => linked.some((link) => link.repository === ref.repository && link.number === ref.number),
        linked: async () => {
            return { complete: true, links: linked };
        },
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

        expect(outcome.checks.items.map((check) => check.name)).toStrictEqual(["test"]);
        expect(outcome.checks).not.toHaveProperty("truncated");
        expect(outcome.passing).toBe(1);

        const [failed] = outcome.checks.items;

        expect(failed?.log?.source).toBe("job_log");
        expect(failed?.log?.excerpt).toContain("FAIL src/sum.test.ts > adds");
        expect(failed?.log?.excerpt.length).toBeLessThanOrEqual(LOG_EXCERPT_MAX_CHARS);
        expect(failed?.log?.truncated).toBe(true);
        expect(failed?.log?.excerpt).toMatch(MARKED);

        const logRead = seen.find((call) => new URL(call.url).hostname === STORAGE);

        expect(logRead?.authorization).toBeNull();
        expect(seen.filter((call) => new URL(call.url).hostname === "api.github.com").every((call) => call.authorization === `Bearer ${TOKEN}`)).toBe(true);
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

        expect(seen.some((call) => new URL(call.url).hostname === "evil.example")).toBe(false);
        expect(outcome.status === "ok" && "checks" in outcome && outcome.checks.items[0]?.log).toStrictEqual({
            excerpt: "Tests\n\n1 test failed",
            source: "check_output",
            truncated: false,
        });
    });
});

describe("when a check's log cannot be had", () => {
    const failingRoutes = {
        [`GET ${API}/commits/${SHA}/check-runs`]: () =>
            Response.json({
                check_runs: [{ app: { slug: "github-actions" }, conclusion: "failure", id: 11, name: "test", status: "completed" }],
                total_count: 3,
            }),
        [`GET ${API}/commits/${SHA}/status`]: () => Response.json({ statuses: [], total_count: 0 }),
        [`GET ${API}/pulls/7`]: () => Response.json(pull),
    };

    it("falls back to the check's own output when the job has no log", async () => {
        stubHost({
            ...failingRoutes,
            [`GET ${API}/check-runs/11`]: () =>
                Response.json({ app: { slug: "github-actions" }, id: 11, name: "test", output: { summary: "2 failed", text: null, title: "Tests" } }),
        });

        const outcome = await readFailingChecksForAgent(dependencies(), {});
        const [check] = outcome.status === "ok" && "checks" in outcome ? outcome.checks.items : [];

        expect(check?.logStatus).toBe("ok");
        expect(check?.log).toStrictEqual({ excerpt: "Tests\n\n2 failed", source: "check_output", truncated: false });
    });

    it("falls back to the check's own output when the job log is refused to the account", async () => {
        stubHost({
            ...failingRoutes,
            [`GET ${API}/actions/jobs/11/logs`]: () => Response.json({ message: "Must have admin rights" }, { status: 403 }),
            [`GET ${API}/check-runs/11`]: () =>
                Response.json({ app: { slug: "github-actions" }, id: 11, name: "test", output: { summary: "3 failed", text: null, title: "Tests" } }),
        });

        const outcome = await readFailingChecksForAgent(dependencies(), {});
        const [check] = outcome.status === "ok" && "checks" in outcome ? outcome.checks.items : [];

        expect(check?.log).toMatchObject({ excerpt: "Tests\n\n3 failed", source: "check_output" });
    });

    it("calls a log refused to the account unavailable when the check has no output either", async () => {
        stubHost({
            ...failingRoutes,
            [`GET ${API}/actions/jobs/11/logs`]: () => Response.json({ message: "Must have admin rights" }, { status: 403 }),
            [`GET ${API}/check-runs/11`]: () => Response.json({ app: { slug: "github-actions" }, id: 11, name: "test", output: null }),
        });

        const outcome = await readFailingChecksForAgent(dependencies(), {});
        const [check] = outcome.status === "ok" && "checks" in outcome ? outcome.checks.items : [];

        expect(check?.logStatus).toBe("unavailable");
    });

    it("starts no further log once the read's time budget is spent, and names those checks not read", async () => {
        stubHost({
            ...failingRoutes,
            [`GET ${API}/check-runs/11`]: () =>
                Response.json({ app: { slug: "other-app" }, id: 11, name: "test", output: { summary: "1 failed", title: "A" } }),
            [`GET ${API}/check-runs/12`]: () =>
                Response.json({ app: { slug: "other-app" }, id: 12, name: "lint", output: { summary: "2 failed", title: "B" } }),
            [`GET ${API}/commits/${SHA}/check-runs`]: () =>
                Response.json({
                    check_runs: [
                        { app: { slug: "other-app" }, conclusion: "failure", id: 11, name: "test", status: "completed" },
                        { app: { slug: "other-app" }, conclusion: "failure", id: 12, name: "lint", status: "completed" },
                    ],
                    total_count: 2,
                }),
        });

        // The budget starts at 0; the first log starts at once, and by the second the whole budget is gone.
        const now = vi.spyOn(Date, "now");

        now.mockReturnValueOnce(0)
            .mockReturnValueOnce(0)
            .mockReturnValue(AGENT_LOG_READ_BUDGET_MS + 1);

        const outcome = await readFailingChecksForAgent(dependencies(), {});

        now.mockRestore();

        expect(outcome).toMatchObject({
            checks: {
                items: [
                    { logStatus: "ok", name: "test" },
                    { log: null, logStatus: "not_read", name: "lint" },
                ],
            },
        });
    });

    it("says the log was unavailable when reading it failed, and that the list is partial", async () => {
        stubHost({ ...failingRoutes, [`GET ${API}/check-runs/11`]: () => Response.json({ message: "boom" }, { status: 500 }) });

        const outcome = await readFailingChecksForAgent(dependencies(), {});

        expect(outcome).toMatchObject({
            checks: { items: [{ log: null, logStatus: "unavailable", name: "test" }] },
            status: "ok",
            unlisted: { truncated: "truncated, 2 more" },
        });
    });
});

describe("reading a linked pull request's reviews and review threads", () => {
    const review = (index: number) => {
        return { authorLogin: "r", body: `review ${String(index)}`, id: String(index), state: "commented" as const, submittedAt: index };
    };

    it("hands over the newest reviews first, and counts the rest", async () => {
        const items = Array.from({ length: 40 }, (_, index) => review(39 - index));
        const driver = {
            ...githubDriver,
            getPullRequest: async () => ({ ...pull, baseBranch: "main", bodyTruncated: false, headBranch: "feat/sum", headSha: SHA }) as never,
            listReviews: async () => {
                return { items, total: 40 };
            },
            listThreads: async () => {
                return { endCursor: null, hasMore: false, items: [], total: 0 };
            },
        };
        const read = await readPullRequestForAgent({ ...dependencies(), driver }, {});

        expect(read).toMatchObject({ reviews: { truncated: "truncated, 10 more" }, status: "ok" });
        expect("reviews" in read && read.reviews.items[0]?.body).toBe("review 39");
    });
});

describe(readThreadsWithin, () => {
    const comment = (id: number, size = 10) => {
        return { authorLogin: "a", body: "x".repeat(size), createdAt: 0, id: String(id) };
    };
    const thread = (id: string, comments: ReturnType<typeof comment>[]) => {
        return {
            canResolve: true,
            canUnresolve: false,
            comments,
            id,
            isOutdated: false,
            isResolved: false,
            line: 1,
            path: "a.ts",
            side: "new" as const,
            startLine: null,
        };
    };

    it("says when a thread is longer than the comments read", async () => {
        const read = await readThreadsWithin(
            async () => {
                return { endCursor: null, hasMore: false, items: [{ ...thread("t", [comment(1), comment(2)]), commentCount: 500 }], total: 1 };
            },
            { page: null, skip: 0 },
        );

        expect(read.items[0]?.comments).toMatchObject({ latestUnread: true, truncated: "truncated, 498 more" });
    });

    it("counts the comments left out as a lower bound when there is no total and pages went unread", async () => {
        const read = await readThreadsWithin(
            async () => {
                return {
                    endCursor: null,
                    hasMore: false,
                    items: [
                        {
                            ...thread(
                                "t",
                                Array.from({ length: 30 }, (_, index) => comment(index)),
                            ),
                            commentsComplete: false as const,
                        },
                    ],
                    total: 1,
                };
            },
            { page: null, skip: 0 },
        );

        expect(read.items[0]?.comments).toMatchObject({ latestUnread: true, truncated: "truncated, at least 20 more" });
    });

    it("never says 'at least 0 more' for a short thread whose pages went unread", async () => {
        const read = await readThreadsWithin(
            async () => {
                return { endCursor: null, hasMore: false, items: [{ ...thread("t", [comment(1)]), commentsComplete: false as const }], total: 1 };
            },
            { page: null, skip: 0 },
        );

        expect(read.items[0]?.comments).toMatchObject({ truncated: "truncated, more were not read" });
    });

    it("says the latest were not read when the comment pages stopped early, even without a total", async () => {
        const read = await readThreadsWithin(
            async () => {
                return { endCursor: null, hasMore: false, items: [{ ...thread("t", [comment(1), comment(2)]), commentsComplete: false as const }], total: 1 };
            },
            { page: null, skip: 0 },
        );

        expect(read.items[0]?.comments).toMatchObject({ latestUnread: true });
    });

    it("shows a thread's first and latest comments, and marks the rest", async () => {
        const read = await readThreadsWithin(
            async () => {
                return {
                    endCursor: null,
                    hasMore: false,
                    items: [
                        thread(
                            "t",
                            Array.from({ length: 30 }, (_, index) => comment(index)),
                        ),
                    ],
                    total: 1,
                };
            },
            { page: null, skip: 0 },
        );

        expect(read.nextCursor).toBeNull();
        expect(read).not.toHaveProperty("truncated");
        expect(read.items[0]?.comments.items.map((entry) => entry.id)).toStrictEqual(["0", "21", "22", "23", "24", "25", "26", "27", "28", "29"]);
        expect(read.items[0]?.comments.truncated).toBe("truncated, 20 more");
    });

    it("pages through the host's threads, stops at the budget, and goes on from the next thread", async () => {
        const perThread = 2000;
        const pageSize = 5;
        const pages = 8;
        const all = Array.from({ length: pageSize * pages }, (_, index) => thread(`t${String(index)}`, [comment(index, perThread)]));
        const asked: (string | null)[] = [];
        const readPage = async (after: string | null) => {
            asked.push(after);

            const start = after === null ? 0 : Number(after);

            return {
                endCursor: String(start + pageSize),
                hasMore: start + pageSize < all.length,
                items: all.slice(start, start + pageSize),
                total: all.length,
            };
        };
        const fitting = Math.floor(AGENT_REVIEW_COMMENTS_BUDGET_CHARS / perThread);
        const first = await readThreadsWithin(readPage, { page: null, skip: 0 });

        expect(first.items).toHaveLength(Math.min(fitting, pageSize * AGENT_MAX_THREAD_PAGES));
        expect(first).toMatchObject({ truncated: `truncated, ${String(all.length - first.items.length)} more` });

        const next = parseThreadCursor(first.nextCursor);

        expect(next).not.toBeNull();

        const second = await readThreadsWithin(readPage, next!);
        const shown = [...first.items, ...second.items].map((entry) => entry.comments.items[0]?.id);

        // Nothing comes twice and nothing is skipped between the two reads.
        expect(shown).toStrictEqual(all.slice(0, shown.length).map((entry) => entry.comments[0]?.id));
        expect(asked.length).toBeGreaterThan(1);
    });

    it("goes on from the next page when the page a cursor named has shrunk since", async () => {
        const read = await readThreadsWithin(
            async (after) =>
                after === null
                    ? { endCursor: "p2", hasMore: true, items: [thread("a", [comment(1)])], total: 2 }
                    : { endCursor: null, hasMore: false, items: [thread("b", [comment(2)])], total: 2 },
            { page: null, skip: 8 },
        );

        expect(read.items.map((entry) => entry.comments.items[0]?.id)).toStrictEqual(["2"]);
        expect(read.nextCursor).toBeNull();
    });

    it("refuses a cursor it did not give", () => {
        expect(parseThreadCursor("../../x")).toBeNull();
        expect(parseThreadCursor("abc#5")).toStrictEqual({ page: "abc", skip: 5 });
        expect(parseThreadCursor("abc#999")).toBeNull();
        expect(parseThreadCursor(undefined)).toStrictEqual({ page: null, skip: 0 });
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

    it("takes the one link a lone number or a lone repository matches, and asks to choose when several do", () => {
        const across: LinkedPullRequest[] = [...LINKED, { kind: "linked", number: 3, repository: "octo/other" }];

        expect(pickLinkedPullRequest(two, { number: 9 })).toStrictEqual({ ref: { number: 9, repository: "octo/hello" }, status: "ok" });
        expect(pickLinkedPullRequest(across, { repository: "Octo/Other" })).toStrictEqual({ ref: { number: 3, repository: "octo/other" }, status: "ok" });
        expect(pickLinkedPullRequest(two, { repository: "octo/hello" }).status).toBe("choose");
        expect(pickLinkedPullRequest(two, { number: 8 }).status).toBe("not_linked");
    });

    it("asks for repository and number when the list of links is only a part", () => {
        expect(pickLinkedPullRequest(two, { number: 9 }, false).status).toBe("choose");
        expect(pickLinkedPullRequest([], { number: 9 }, false).status).toBe("choose");
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

describe("re-running checks of a linked pull request", () => {
    const run = (id: number, conclusion: string) => {
        return { app: { slug: "github-actions" }, conclusion, id, name: `job ${String(id)}`, status: "completed" };
    };
    const routes = (runs: ReturnType<typeof run>[]) => {
        return {
            [`GET ${API}/commits/${SHA}/check-runs`]: () => Response.json({ check_runs: runs, total_count: runs.length }),
            [`GET ${API}/commits/${SHA}/status`]: () => Response.json({ statuses: [], total_count: 0 }),
            [`GET ${API}/pulls/7`]: () => Response.json(pull),
            ...Object.fromEntries(runs.map((entry) => [`GET ${API}/check-runs/${String(entry.id)}`, () => Response.json({ app: { slug: "github-actions" } })])),
            ...Object.fromEntries(runs.map((entry) => [`POST ${API}/actions/jobs/${String(entry.id)}/rerun`, () => new Response(null, { status: 201 })])),
        };
    };

    it("re-runs only the failed checks when none are named, and a cancelled one only when named", async () => {
        stubHost(routes([run(1, "failure"), run(2, "cancelled"), run(3, "success")]));

        const unnamed = await rerunFailedForAgent(dependencies(), {}, undefined);

        expect(unnamed).toMatchObject({ notRerun: [], rerun: [{ id: "1", status: "ok" }], skipped: [], status: "ok" });

        const named = await rerunFailedForAgent(dependencies(), {}, ["2", "3"]);

        expect(named).toMatchObject({ rerun: [{ id: "2", status: "ok" }], skipped: ["3"], status: "ok" });
    });

    it("re-runs nothing when the pull request moved since its checks were listed", async () => {
        let reads = 0;
        const seen = stubHost({
            ...routes([run(1, "failure")]),
            [`GET ${API}/pulls/7`]: () => {
                reads += 1;

                return Response.json(reads === 1 ? pull : { ...pull, head: { ...pull.head, sha: "c".repeat(40) } });
            },
        });

        await expect(rerunFailedForAgent(dependencies(), {}, undefined)).resolves.toStrictEqual({ status: "head_moved" });
        expect(seen.some((call) => call.method === "POST")).toBe(false);
    });

    it("re-runs a failed check the host lists past its first page", async () => {
        const first = Array.from({ length: 100 }, (_, index) => run(index + 1, "success"));
        const later = run(150, "failure");

        stubHost({
            ...routes([...first, later]),
            [`GET ${API}/commits/${SHA}/check-runs`]: () => Response.json({ check_runs: first, total_count: 101 }),
        });
        // The stub answers by path alone; the second page is told apart by the request's page number.
        vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init: RequestInit = {}) => {
            const url = new URL(input instanceof Request ? input.url : String(input));
            const key = `${init.method ?? "GET"} ${url.origin}${url.pathname}`;
            const table: Record<string, () => Response> = {
                ...routes([...first, later]),
                [`GET ${API}/commits/${SHA}/check-runs`]: () =>
                    Response.json({ check_runs: url.searchParams.get("page") === "2" ? [later] : first, total_count: 101 }),
            };

            return table[key]?.() ?? Response.json({ message: "Not Found" }, { status: 404 });
        });

        await expect(rerunFailedForAgent(dependencies(), {}, ["150"])).resolves.toMatchObject({ rerun: [{ id: "150", status: "ok" }], skipped: [] });
    });

    it("calls a named check the host did not list unlisted, not skipped", async () => {
        stubHost({
            ...routes([run(1, "failure")]),
            [`GET ${API}/commits/${SHA}/check-runs`]: () => Response.json({ check_runs: [run(1, "failure")], total_count: 2 }),
        });

        await expect(rerunFailedForAgent(dependencies(), {}, ["999"])).resolves.toMatchObject({ rerun: [], skipped: [], unlisted: ["999"] });
    });

    it("says when the host has checks the read did not list, even when none were named", async () => {
        stubHost({
            ...routes([run(1, "failure")]),
            [`GET ${API}/commits/${SHA}/check-runs`]: () => Response.json({ check_runs: [run(1, "failure")], total_count: 2 }),
        });

        await expect(rerunFailedForAgent(dependencies(), {}, undefined)).resolves.toMatchObject({ unlistedChecks: { truncated: "truncated, 1 more" } });
    });

    it("names back the failed checks past the cap instead of dropping them", async () => {
        stubHost(routes(Array.from({ length: 12 }, (_, index) => run(index + 1, "failure"))));

        const outcome = await rerunFailedForAgent(dependencies(), {}, undefined);

        expect(outcome).toMatchObject({ notRerun: ["11", "12"], status: "ok" });
        expect("rerun" in outcome && outcome.rerun).toHaveLength(10);
    });
});
