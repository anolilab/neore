import { describe, expect, it } from "vitest";

import { leftOutPast } from "../coverage";
import { HostApiError } from "../origin-fetch";
import type { HostRequest } from "../origin-fetch";
import {
    GITHUB_CAPABILITIES,
    GITHUB_FILE_LIMIT,
    GITHUB_PAGE_SIZE,
    githubDriver,
    inboxQuery,
    PAGE_PATCH_BUDGET_CHARS,
    PATCH_MAX_CHARS,
    splitGithubRepo,
} from "./github";

const REF = { number: 7, repository: "octo/hello" };
const SHA = "a".repeat(40);

interface Call {
    path: string;
    query: Record<string, number | string>;
}

/** A host that answers each path from `routes`, and records what was asked. */
const fakeHost = (routes: Record<string, (query: Record<string, number | string>) => unknown>): { calls: Call[]; request: HostRequest } => {
    const calls: Call[] = [];
    const request: HostRequest = async (path, options) => {
        const query = options?.query ?? {};

        calls.push({ path, query });

        const route = routes[path];

        if (!route) {
            throw new HostApiError(`no route ${path}`, 404);
        }

        return Response.json(route(query));
    };

    return { calls, request };
};

const pullBody = (overrides: Record<string, unknown> = {}) => {
    return {
        additions: 10,
        base: { ref: "main" },
        body: "Fixes the thing",
        changed_files: 3,
        commits: 2,
        created_at: "2026-10-01T10:00:00Z",
        deletions: 4,
        draft: false,
        head: { ref: "fix/thing", sha: SHA },
        html_url: "https://github.com/octo/hello/pull/7",
        merged: false,
        number: 7,
        state: "open",
        title: "Fix the thing",
        updated_at: "2026-10-02T10:00:00Z",
        user: { login: "octocat" },
        ...overrides,
    };
};

/** `total` changed files, served 100 to a page like GitHub, up to its 3000. */
const filesRoute =
    (total: number, patch: (index: number) => string | undefined = () => "@@ -1 +1 @@\n-a\n+b") =>
    (query: Record<string, number | string>) => {
        const page = Number(query.page);
        const perPage = Number(query.per_page);
        const listable = Math.min(total, GITHUB_FILE_LIMIT);
        const start = (page - 1) * perPage;

        return Array.from({ length: Math.max(0, Math.min(perPage, listable - start)) }, (_, offset) => {
            const index = start + offset;
            const text = patch(index);

            return { additions: 1, deletions: 1, filename: `src/file-${index}.ts`, status: "modified", ...(text !== undefined && { patch: text }) };
        });
    };

/** Pages through a driver the way the page does: until `hasMore` is false. */
const listEveryFile = async (request: HostRequest) => {
    const files = [];

    let page = 1;
    let more = true;

    while (more) {
        const result = await githubDriver.listFiles(request, REF, page);

        files.push(...result.files);
        more = result.hasMore;
        page += 1;
    }

    return files;
};

describe("github driver: files", () => {
    it.each([
        [3, 3, 0],
        [100, 100, 0],
        [301, 301, 0],
        [350, 350, 0],
        [2999, 2999, 0],
        [3000, 3000, 0],
        [3001, 3000, 1],
        [3250, 3000, 250],
    ])("a pull request of %i files lists %i and leaves %i out", async (total, listed, leftOut) => {
        const { calls, request } = fakeHost({ "/repos/octo/hello/pulls/7/files": filesRoute(total) });
        const files = await listEveryFile(request);

        expect(files).toHaveLength(listed);
        expect(new Set(files.map((file) => file.path)).size).toBe(listed);
        expect(leftOutPast(total, GITHUB_FILE_LIMIT)).toBe(leftOut);
        // The pages the host lists, and one empty one when the last is exactly full (the driver cannot tell). Never past the limit.
        const trailingEmptyPage = total < GITHUB_FILE_LIMIT && total % GITHUB_PAGE_SIZE === 0 ? 1 : 0;

        expect(calls).toHaveLength(Math.ceil(Math.min(total, GITHUB_FILE_LIMIT) / GITHUB_PAGE_SIZE) + trailingEmptyPage);
        expect(calls.every((call) => call.query.per_page === GITHUB_PAGE_SIZE)).toBe(true);
    });

    it("never asks for a page past the host's last, whatever the client sends", async () => {
        const { calls, request } = fakeHost({ "/repos/octo/hello/pulls/7/files": filesRoute(3250) });

        await githubDriver.listFiles(request, REF, 9999);
        await githubDriver.listFiles(request, REF, -4);
        await githubDriver.listFiles(request, REF, NaN);

        expect(calls.map((call) => call.query.page)).toEqual([30, 1, 1]);
    });

    it("keeps a file's patch, and says when the host sent none", async () => {
        const { request } = fakeHost({
            "/repos/octo/hello/pulls/7/files": () => [
                { additions: 1, deletions: 0, filename: "a.ts", patch: "@@ +1 @@\n+x", status: "added" },
                { additions: 0, deletions: 0, filename: "logo.png", status: "added" },
                { additions: 2, deletions: 2, filename: "new.ts", previous_filename: "old.ts", status: "renamed" },
                { additions: 0, deletions: 0, filename: "odd.ts", status: "something-new" },
            ],
        });
        const { files } = await githubDriver.listFiles(request, REF, 1);

        expect(files.map((file) => [file.path, file.patchState, file.previousPath, file.status])).toEqual([
            ["a.ts", "full", null, "added"],
            ["logo.png", "host_omitted", null, "added"],
            ["new.ts", "host_omitted", "old.ts", "renamed"],
            ["odd.ts", "host_omitted", null, "changed"],
        ]);
        expect(files[1]?.patch).toBeNull();
    });

    it("cuts one oversized patch and bounds the whole page", async () => {
        const big = "+".repeat(PATCH_MAX_CHARS * 2);
        const { request } = fakeHost({ "/repos/octo/hello/pulls/7/files": filesRoute(30, () => big) });
        const { files } = await githubDriver.listFiles(request, REF, 1);
        const kept = files.reduce((sum, file) => sum + (file.patch?.length ?? 0), 0);

        expect(files[0]).toMatchObject({ patchState: "truncated" });
        expect(files[0]?.patch).toHaveLength(PATCH_MAX_CHARS);
        expect(kept).toBeLessThanOrEqual(PAGE_PATCH_BUDGET_CHARS);
        expect(files.at(-1)).toMatchObject({ patch: null, patchState: "over_budget" });
        // Every file is still listed; only its patch is left out.
        expect(files).toHaveLength(30);
    });

    it("skips an entry that has no file name rather than failing the page", async () => {
        const { request } = fakeHost({
            "/repos/octo/hello/pulls/7/files": () => [{ additions: 1 }, { additions: 1, deletions: 1, filename: "ok.ts", status: "added" }],
        });
        const { files } = await githubDriver.listFiles(request, REF, 1);

        expect(files.map((file) => file.path)).toEqual(["ok.ts"]);
    });
});

describe("github driver: a pull request", () => {
    it("reads the description, branches and counts", async () => {
        const { request } = fakeHost({ "/repos/octo/hello/pulls/7": () => pullBody() });

        expect(await githubDriver.getPullRequest(request, REF)).toMatchObject({
            authorLogin: "octocat",
            baseBranch: "main",
            body: "Fixes the thing",
            bodyTruncated: false,
            changedFiles: 3,
            commitCount: 2,
            headBranch: "fix/thing",
            headSha: SHA,
            repository: "octo/hello",
            state: "open",
            url: "https://github.com/octo/hello/pull/7",
        });
    });

    it.each([
        [{ merged: true, state: "closed" }, "merged"],
        [{ merged: false, state: "closed" }, "closed"],
        [{ draft: true }, "open"],
    ])("reads %j as %s", async (overrides, state) => {
        const { request } = fakeHost({ "/repos/octo/hello/pulls/7": () => pullBody(overrides) });

        const detail = await githubDriver.getPullRequest(request, REF);

        expect(detail.state).toBe(state);
    });

    it("keeps no link that is not a GitHub address", async () => {
        const { request } = fakeHost({ "/repos/octo/hello/pulls/7": () => pullBody({ html_url: "https://evil.example/octo/hello/pull/7" }) });

        const detail = await githubDriver.getPullRequest(request, REF);

        expect(detail.url).toBe("https://github.com/octo/hello/pull/7");
    });

    it("cuts a very long description and says so; a deleted author reads as ghost", async () => {
        const { request } = fakeHost({ "/repos/octo/hello/pulls/7": () => pullBody({ body: "x".repeat(100_000), user: null }) });
        const detail = await githubDriver.getPullRequest(request, REF);

        expect(detail.body).toHaveLength(60_000);
        expect(detail.bodyTruncated).toBe(true);
        expect(detail.authorLogin).toBe("ghost");
    });

    it("fails on a response without the fields it needs", async () => {
        const { request } = fakeHost({
            "/repos/octo/hello/pulls/7": () => {
                return { title: "no number" };
            },
        });

        await expect(githubDriver.getPullRequest(request, REF)).rejects.toBeInstanceOf(HostApiError);
    });

    it.each(["octo/hello/extra", "octo", "octo/..", "../hello", "oc to/hello", "octo/hel/lo", ""])(
        "refuses the repository %j before any request",
        async (repo) => {
            const { calls, request } = fakeHost({});

            await expect(githubDriver.getPullRequest(request, { number: 1, repository: repo })).rejects.toMatchObject({ status: 404 });
            expect(calls).toEqual([]);
        },
    );

    it.each([0, -1, 1.5, NaN])("refuses the pull request number %s", async (number) => {
        const { request } = fakeHost({});

        await expect(githubDriver.getPullRequest(request, { number, repository: "octo/hello" })).rejects.toBeInstanceOf(HostApiError);
    });

    it("splits a repository into owner and name", () => {
        expect(splitGithubRepo("octo-org/hello.world_js")).toEqual({ name: "hello.world_js", owner: "octo-org" });
        expect(splitGithubRepo("-octo/hello")).toBeUndefined();
        expect(splitGithubRepo("octo_acme/hello")).toEqual({ name: "hello", owner: "octo_acme" });
    });
});

describe("github driver: commits", () => {
    it("reads the commits of a page and stops at the host's ceiling of 250", async () => {
        const commit = (index: number) => {
            return {
                commit: { author: { date: "2026-10-01T10:00:00Z", name: "Octo" }, message: `Change ${index}\n\nBody` },
                sha: String(index).padStart(40, "0"),
            };
        };
        const { request } = fakeHost({
            "/repos/octo/hello/pulls/7/commits": (query) => Array.from({ length: Number(query.page) === 3 ? 50 : 100 }, (_, index) => commit(index)),
        });

        const first = await githubDriver.listCommits(request, REF, 1);
        const last = await githubDriver.listCommits(request, REF, 3);

        expect(first.commits[0]).toMatchObject({ authorName: "Octo", message: "Change 0\n\nBody" });
        expect(first.hasMore).toBe(true);
        expect(last.hasMore).toBe(false);
    });
});

describe("github driver: checks", () => {
    it("joins check runs and commit statuses, and maps every conclusion", async () => {
        const run = (name: string, status: string, conclusion: string | null) => {
            return { conclusion, html_url: `https://github.com/octo/hello/runs/${name}`, name, status };
        };
        const { request } = fakeHost({
            [`/repos/octo/hello/commits/${SHA}/check-runs`]: () => {
                return {
                    check_runs: [
                        run("ok", "completed", "success"),
                        run("bad", "completed", "failure"),
                        run("slow", "completed", "timed_out"),
                        run("manual", "completed", "action_required"),
                        run("off", "completed", "cancelled"),
                        run("skip", "completed", "skipped"),
                        run("meh", "completed", "neutral"),
                        run("old", "completed", "stale"),
                        run("wait", "queued", null),
                        run("busy", "in_progress", null),
                        { conclusion: null, html_url: "https://evil.example/x", name: "foreign", status: "completed" },
                    ],
                    total_count: 140,
                };
            },
            [`/repos/octo/hello/commits/${SHA}/status`]: () => {
                return {
                    statuses: [
                        { context: "ci/legacy", state: "success", target_url: "https://ci.example/1" },
                        { context: "ci/broken", state: "error" },
                        { context: "ci/queued", state: "pending" },
                    ],
                    total_count: 3,
                };
            },
        });
        const { checks, total } = await githubDriver.listChecks(request, REF, SHA);

        expect(checks.map((check) => [check.name, check.state])).toEqual([
            ["ok", "success"],
            ["bad", "failure"],
            ["slow", "failure"],
            ["manual", "failure"],
            ["off", "cancelled"],
            ["skip", "skipped"],
            ["meh", "neutral"],
            ["old", "neutral"],
            ["wait", "pending"],
            ["busy", "pending"],
            ["foreign", "pending"],
            ["ci/legacy", "success"],
            ["ci/broken", "failure"],
            ["ci/queued", "pending"],
        ]);
        expect(total).toBe(143);
        expect(checks.find((check) => check.name === "ok")?.url).toBe("https://github.com/octo/hello/runs/ok");
        expect(checks.find((check) => check.name === "foreign")?.url).toBeNull();
        expect(checks.find((check) => check.name === "ci/legacy")?.url).toBeNull();
    });

    it.each(["main", "../x", "A".repeat(40), ""])("refuses %j as a commit id before any request", async (sha) => {
        const { calls, request } = fakeHost({});

        await expect(githubDriver.listChecks(request, REF, sha)).rejects.toMatchObject({ status: 404 });
        expect(calls).toEqual([]);
    });
});

describe("github driver: inbox", () => {
    const item = (number: number, overrides: Record<string, unknown> = {}) => {
        return {
            comments: 2,
            created_at: "2026-10-01T10:00:00Z",
            draft: false,
            html_url: `https://github.com/octo/hello/pull/${number}`,
            labels: [{ name: "bug" }],
            number,
            repository_url: "https://api.github.com/repos/octo/hello",
            title: `PR ${number}`,
            updated_at: "2026-10-02T10:00:00Z",
            user: { login: "someone" },
            ...overrides,
        };
    };

    it.each([
        ["needsMyReview", "is:pr is:open archived:false review-requested:me draft:false"],
        ["mine", "is:pr is:open archived:false author:me"],
        ["readyToMerge", "is:pr is:open archived:false author:me review:approved draft:false"],
        ["drafts", "is:pr is:open archived:false author:me draft:true"],
    ] as const)("asks the search for %s with the signed-in login", async (section, query) => {
        const { calls, request } = fakeHost({
            "/search/issues": () => {
                return { items: [item(1)], total_count: 1 };
            },
            "/user": () => {
                return { login: "me" };
            },
        });
        const page = await githubDriver.listInbox(request, section, 1);

        expect(calls.find((call) => call.path === "/search/issues")?.query.q).toBe(query);
        expect(inboxQuery(section, "me")).toBe(query);
        expect(page).toMatchObject({ hasMore: false, page: 1, total: 1 });
        expect(page.items[0]).toMatchObject({ authorLogin: "someone", labels: ["bug"], repository: "octo/hello", title: "PR 1" });
    });

    it("reports more pages until the search's own ceiling", async () => {
        const { request } = fakeHost({
            "/search/issues": () => {
                return { items: [item(1)], total_count: 5000 };
            },
            "/user": () => {
                return { login: "me" };
            },
        });

        const first = await githubDriver.listInbox(request, "mine", 1);
        const penultimate = await githubDriver.listInbox(request, "mine", 33);
        const last = await githubDriver.listInbox(request, "mine", 34);
        const beyond = await githubDriver.listInbox(request, "mine", 999);

        expect(first.hasMore).toBe(true);
        expect(penultimate.hasMore).toBe(true);
        expect(last.hasMore).toBe(false);
        expect(beyond.page).toBe(34);
    });

    it("drops an entry whose repository or link is not GitHub's", async () => {
        const { request } = fakeHost({
            "/search/issues": () => {
                return {
                    items: [
                        item(1, { html_url: "https://evil.example/x" }),
                        item(2, { repository_url: "https://evil.example/repos/a/b" }),
                        item(3),
                        { number: "x" },
                    ],
                    total_count: 4,
                };
            },
            "/user": () => {
                return { login: "me" };
            },
        });

        const page = await githubDriver.listInbox(request, "mine", 1);

        expect(page.items.map((entry) => entry.number)).toEqual([3]);
    });
});

describe("github capability report", () => {
    it("declares checks, the inbox, merge, the pull request and the review, and says what Ready to merge approximates", () => {
        expect(Object.keys(GITHUB_CAPABILITIES.groups)).toEqual(["checks", "freshness", "inbox", "merge", "pullRequest", "review"]);
        expect(GITHUB_CAPABILITIES.groups.inbox?.readyToMerge).toMatchObject({ degradation: "synthetic", supported: true });
    });
});

/** A response whose body records being cancelled. */
const tracked = (chunks: string[], init: ResponseInit = {}): { cancelled: () => boolean; response: Response } => {
    let cancelled = false;
    const encoder = new TextEncoder();
    let index = 0;
    const response = new Response(
        new ReadableStream<Uint8Array>({
            cancel() {
                cancelled = true;
            },
            pull(controller) {
                const chunk = chunks[index];

                index += 1;

                if (chunk === undefined) {
                    controller.close();
                } else {
                    controller.enqueue(encoder.encode(chunk));
                }
            },
        }),
        init,
    );

    return { cancelled: () => cancelled, response };
};

describe("github driver: responses that are never read", () => {
    const RUNS = `/repos/octo/hello/commits/${SHA}/check-runs`;
    const STATUS = `/repos/octo/hello/commits/${SHA}/status`;
    const answering =
        (answers: Record<string, () => Response | Promise<never>>): HostRequest =>
        async (path) =>
            await (answers[path] as () => Promise<Response>)();

    it("cancels the status body when the check runs are refused", async () => {
        const status = tracked(['{"statuses":[],"total_count":0}']);
        const request = answering({
            [RUNS]: async () => {
                throw new HostApiError("Host API error: 403 Forbidden", 403);
            },
            [STATUS]: () => status.response,
        });

        await expect(githubDriver.listChecks(request, REF, SHA)).rejects.toMatchObject({ status: 403 });
        expect(status.cancelled()).toBe(true);
    });

    it("cancels the check-runs body when the status is refused", async () => {
        const runs = tracked(['{"check_runs":[],"total_count":0}']);
        const request = answering({
            [RUNS]: () => runs.response,
            [STATUS]: async () => {
                throw new HostApiError("Host API error: 404 Not Found", 404);
            },
        });

        await expect(githubDriver.listChecks(request, REF, SHA)).rejects.toMatchObject({ status: 404 });
        expect(runs.cancelled()).toBe(true);
    });

    it("cancels the status body when the check runs cannot be read", async () => {
        const status = tracked(['{"statuses":[]}']);
        const request = answering({ [RUNS]: () => tracked(["not json"]).response, [STATUS]: () => status.response });

        await expect(githubDriver.listChecks(request, REF, SHA)).rejects.toBeInstanceOf(HostApiError);
        expect(status.cancelled()).toBe(true);
    });

    it("refuses a body that declares more than the cap, without reading it", async () => {
        const big = tracked(["{}"], { headers: { "content-length": "99999999" } });
        const request = answering({ "/repos/octo/hello/pulls/7": () => big.response });

        await expect(githubDriver.getPullRequest(request, REF)).rejects.toMatchObject({ status: 0 });
        expect(big.cancelled()).toBe(true);
    });

    it("answers with a host error when the body read is cut off", async () => {
        const broken = new Response(
            new ReadableStream({
                pull: () => {
                    throw new TypeError("The operation was aborted");
                },
            }),
        );
        const request = answering({ "/repos/octo/hello/pulls/7": () => broken });

        await expect(githubDriver.getPullRequest(request, REF)).rejects.toBeInstanceOf(HostApiError);
    });

    it("stops reading a body that grows past the cap with no length declared", async () => {
        const chunk = "x".repeat(5_000_000);
        const big = tracked([chunk, chunk, chunk, chunk]);
        const request = answering({ "/repos/octo/hello/pulls/7": () => big.response });

        await expect(githubDriver.getPullRequest(request, REF)).rejects.toMatchObject({ status: 0 });
        expect(big.cancelled()).toBe(true);
    });
});

describe("github driver: bounds", () => {
    it("never asks for a commits page past the host's ceiling", async () => {
        const { calls, request } = fakeHost({ "/repos/octo/hello/pulls/7/commits": () => [] });

        await githubDriver.listCommits(request, REF, 9999);

        expect(calls.map((call) => call.query.page)).toEqual([3]);
    });

    it("reads the signed-in login once for one requester", async () => {
        const { calls, request } = fakeHost({
            "/search/issues": () => {
                return { items: [], total_count: 0 };
            },
            "/user": () => {
                return { login: "me" };
            },
        });

        await githubDriver.listInbox(request, "mine", 1);
        await githubDriver.listInbox(request, "drafts", 1);

        expect(calls.filter((call) => call.path === "/user")).toHaveLength(1);
        expect(calls.filter((call) => call.path === "/search/issues")).toHaveLength(2);
    });
});
