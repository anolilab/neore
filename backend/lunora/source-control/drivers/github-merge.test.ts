/**
 * The GitHub driver's checks and merge half against recorded response shapes (required
 * checks from rulesets and branch protection, re-runs, merge settings, the merge call and
 * auto-merge), not live GitHub. The last block runs the driver through `writeToHost` to
 * show what a person is told when the host refuses.
 */
import { describe, expect, it } from "vitest";

import { HostApiError } from "../origin-fetch";
import type { HostRequest, HostRequestOptions } from "../origin-fetch";
import { writeToHost } from "../write-host";
import { githubDriver, lastPageOf } from "./github";

const REF = { number: 7, repository: "octo/hello" };
const SHA = "a".repeat(40);
const REPO = "/repos/octo/hello";

interface Sent {
    json: any;
    method: string;
    path: string;
}

type Answer = unknown | HostApiError | ((sent: Sent) => unknown);

/** A host that answers by exact path; a path nobody declared is a 404, as at the host. */
const host = (routes: Record<string, Answer>) => {
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

const run = (id: number, name: string, conclusion = "success", app = "github-actions") => {
    return { app: { slug: app }, conclusion, html_url: `https://github.com/octo/hello/runs/${id}`, id, name, status: "completed" };
};

const checksRoutes = (runs: ReturnType<typeof run>[], statuses: unknown[] = []) => {
    return {
        [`${REPO}/commits/${SHA}/check-runs`]: { check_runs: runs, total_count: runs.length },
        [`${REPO}/commits/${SHA}/status`]: { statuses, total_count: statuses.length },
        [`${REPO}/pulls/7`]: { base: { ref: "main" } },
    };
};

describe("required checks", () => {
    const listed = async (routes: Record<string, Answer>) => {
        const { checks } = await githubDriver.listChecks(host(routes).request, REF, SHA);

        return Object.fromEntries(checks.map((check) => [check.name, check.required]));
    };

    it("marks what a ruleset requires, and leaves the rest optional when every source was read", async () => {
        const required = await listed({
            ...checksRoutes([run(1, "build"), run(2, "ci/unit"), run(3, "coverage-report", "failure")]),
            [`${REPO}/branches/main`]: { protected: false },
            [`${REPO}/rules/branches/main`]: [
                { parameters: { dismiss_stale_reviews_on_push: false, required_approving_review_count: 1 }, type: "pull_request" },
                { parameters: { required_status_checks: [{ context: "build" }, { context: "ci/*" }] }, type: "required_status_checks" },
            ],
        });

        expect(required).toEqual({ build: true, "ci/unit": true, "coverage-report": false });
    });

    it("reads branch protection's contexts and checks too", async () => {
        const required = await listed({
            ...checksRoutes([run(1, "build"), run(2, "lint"), run(3, "docs")]),
            [`${REPO}/branches/main/protection/required_status_checks`]: { checks: [{ context: "lint" }], contexts: ["build"] },
            [`${REPO}/branches/main`]: { protected: true },
            [`${REPO}/rules/branches/main`]: [],
        });

        expect(required).toEqual({ build: true, docs: false, lint: true });
    });

    it("matches a pattern with the glob matcher, and a commit status by its context", async () => {
        const { checks } = await githubDriver.listChecks(
            host({
                ...checksRoutes([run(1, "build (linux)")], [{ context: "ci/legacy", state: "failure" }]),
                [`${REPO}/branches/main`]: { protected: false },
                [`${REPO}/rules/branches/main`]: [
                    { parameters: { required_status_checks: [{ context: "build (*)" }, { context: "ci/*" }] }, type: "required_status_checks" },
                ],
            }).request,
            REF,
            SHA,
        );

        expect(checks.map((check) => [check.name, check.required])).toEqual([
            ["build (linux)", true],
            ["ci/legacy", true],
        ]);
    });

    it("leaves a check unknown, not optional, when branch protection is withheld from the reader", async () => {
        const required = await listed({
            ...checksRoutes([run(1, "build"), run(2, "docs")]),
            [`${REPO}/branches/main/protection/required_status_checks`]: new HostApiError("Must have admin rights", 403),
            [`${REPO}/rules/branches/main`]: [{ parameters: { required_status_checks: [{ context: "build" }] }, type: "required_status_checks" }],
        });

        expect(required).toEqual({ build: true, docs: null });
    });

    it("keeps the branch's own required-check summary when the protection read answers 403", async () => {
        const required = await listed({
            ...checksRoutes([run(1, "build"), run(2, "docs")]),
            [`${REPO}/branches/main/protection/required_status_checks`]: new HostApiError("Must have admin rights", 403),
            [`${REPO}/branches/main`]: { protected: true, protection: { required_status_checks: { contexts: ["build"] } } },
            [`${REPO}/rules/branches/main`]: [],
        });

        expect(required).toEqual({ build: true, docs: false });
    });

    it("leaves every check unknown when no rules could be read, and still lists them", async () => {
        expect(await listed(checksRoutes([run(1, "build")]))).toEqual({ build: null });
    });

    it("hands a rate limit to the caller instead of calling every check unknown", async () => {
        await expect(
            githubDriver.listChecks(
                host({ ...checksRoutes([run(1, "build")]), [`${REPO}/rules/branches/main`]: new HostApiError("x", 403, true) }).request,
                REF,
                SHA,
            ),
        ).rejects.toMatchObject({ rateLimited: true });
    });

    it("reads every check as unknown, without a request, when the base branch cannot be a path", async () => {
        const { request, sent } = host({ ...checksRoutes([run(1, "build")]), [`${REPO}/pulls/7`]: { base: { ref: "main/../../admin" } } });

        const { checks, required } = await githubDriver.listChecks(request, REF, SHA);

        expect(checks.map((check) => check.required)).toEqual([null]);
        expect(required).toEqual({ complete: false, patterns: [] });
        expect(sent.some((call) => call.path.includes("admin"))).toBe(false);
    });

    it.each(["feature/über", "fix#12", "release,v2", "what?", "100%", "a b"])("reads the rules of a base branch named %j", async (branch) => {
        const encoded = branch
            .split("/")
            .map((segment) => encodeURIComponent(segment))
            .join("/");
        const { request, sent } = host({
            ...checksRoutes([run(1, "build")]),
            [`${REPO}/branches/${encoded}`]: { protected: false },
            [`${REPO}/pulls/7`]: { base: { ref: branch } },
            [`${REPO}/rules/branches/${encoded}`]: [{ parameters: { required_status_checks: [{ context: "build" }] }, type: "required_status_checks" }],
        });

        const { checks } = await githubDriver.listChecks(request, REF, SHA);

        expect(checks.map((check) => check.required)).toEqual([true]);
        expect(sent.map((call) => call.path)).toContain(`${REPO}/rules/branches/${encoded}`);
    });

    it.each(["", "a//b", "./x", "x/.", "x/../y", "x".repeat(251), "\u{D800}"])("leaves checks unknown for the unusable base branch %j", async (branch) => {
        const { request } = host({ ...checksRoutes([run(1, "build")]), [`${REPO}/pulls/7`]: { base: { ref: branch } } });

        const { checks, required } = await githubDriver.listChecks(request, REF, SHA);

        expect(checks.map((check) => check.required)).toEqual([null]);
        expect(required.complete).toBe(false);
    });

    it("returns the patterns so a required check that has not reported can be waited on", async () => {
        const { required } = await githubDriver.listChecks(
            host({
                ...checksRoutes([run(1, "lint")]),
                [`${REPO}/branches/main`]: { protected: false },
                [`${REPO}/rules/branches/main`]: [
                    { parameters: { required_status_checks: [{ context: "lint" }, { context: "build" }] }, type: "required_status_checks" },
                ],
            }).request,
            REF,
            SHA,
        );

        expect(required).toEqual({ complete: true, patterns: ["lint", "build"] });
    });

    it("does not call the rules complete when the rules page is full", async () => {
        const { required } = await githubDriver.listChecks(
            host({
                ...checksRoutes([run(1, "lint")]),
                [`${REPO}/branches/main`]: { protected: false },
                [`${REPO}/rules/branches/main`]: Array.from({ length: 100 }, () => {
                    return { type: "pull_request" };
                }),
            }).request,
            REF,
            SHA,
        );

        expect(required.complete).toBe(false);
    });

    it("encodes each segment of a branch name that has slashes", async () => {
        const { request, sent } = host({
            ...checksRoutes([run(1, "build")]),
            [`${REPO}/branches/release/1.x`]: { protected: false },
            [`${REPO}/pulls/7`]: { base: { ref: "release/1.x" } },
            [`${REPO}/rules/branches/release/1.x`]: [],
        });

        await githubDriver.listChecks(request, REF, SHA);

        expect(sent.map((call) => call.path)).toContain(`${REPO}/rules/branches/release/1.x`);
    });
});

describe("rerunCheck", () => {
    it("re-runs ONE Actions job, not its workflow", async () => {
        const { request, sent } = host({
            [`${REPO}/actions/jobs/55/rerun`]: {},
            [`${REPO}/check-runs/55`]: run(55, "build"),
        });

        await githubDriver.rerunCheck(request, REF, "55");

        expect(sent.filter((call) => call.method !== "GET")).toEqual([{ json: {}, method: "POST", path: `${REPO}/actions/jobs/55/rerun` }]);
        expect(sent.some((call) => call.path.includes("/actions/runs/"))).toBe(false);
    });

    it("asks another app to run its one check again", async () => {
        const { request, sent } = host({
            [`${REPO}/check-runs/56/rerequest`]: {},
            [`${REPO}/check-runs/56`]: run(56, "scan", "failure", "some-scanner"),
        });

        await githubDriver.rerunCheck(request, REF, "56");

        expect(sent.filter((call) => call.method !== "GET").map((call) => call.path)).toEqual([`${REPO}/check-runs/56/rerequest`]);
    });

    it("keeps the host's reason for a re-run it refuses with a 403", async () => {
        const { request } = host({
            [`${REPO}/actions/jobs/55/rerun`]: new HostApiError("Forbidden", 403, false, {
                detail: "Cannot re-run a job while others in the run are in progress",
            }),
            [`${REPO}/check-runs/55`]: run(55, "build"),
        });

        await expect(githubDriver.rerunCheck(request, REF, "55")).rejects.toMatchObject({
            detail: "Cannot re-run a job while others in the run are in progress",
            status: 422,
        });
    });

    it("leaves a bare 403, and a rate-limited one, as they are", async () => {
        const bare = host({ [`${REPO}/actions/jobs/55/rerun`]: new HostApiError("Forbidden", 403), [`${REPO}/check-runs/55`]: run(55, "build") });
        const limited = host({
            [`${REPO}/actions/jobs/55/rerun`]: new HostApiError("Forbidden", 403, true, { detail: "You have exceeded a secondary rate limit." }),
            [`${REPO}/check-runs/55`]: run(55, "build"),
        });

        await expect(githubDriver.rerunCheck(bare.request, REF, "55")).rejects.toMatchObject({ status: 403 });
        await expect(githubDriver.rerunCheck(limited.request, REF, "55")).rejects.toMatchObject({ rateLimited: true, status: 403 });
    });

    it.each(["", "abc", "1/../2", "12345678901234567890123"])("refuses %j as a check id before any request", async (id) => {
        const { request, sent } = host({});

        await expect(githubDriver.rerunCheck(request, REF, id)).rejects.toMatchObject({ status: 404 });
        expect(sent).toEqual([]);
    });
});

describe("getMergeStatus", () => {
    it("reads the allowed methods, auto-merge and the host's word on mergeability", async () => {
        const { request } = host({
            [`${REPO}/pulls/7`]: { auto_merge: null, mergeable_state: "blocked" },
            [REPO]: { allow_auto_merge: true, allow_merge_commit: false, allow_rebase_merge: true, allow_squash_merge: true },
        });

        expect(await githubDriver.getMergeStatus(request, REF)).toEqual({
            autoMergeAllowed: true,
            autoMergeEnabled: false,
            methods: ["squash", "rebase"],
            state: "blocked",
        });
    });

    it.each([
        ["clean", "clean"],
        ["unstable", "unstable"],
        ["behind", "behind"],
        ["dirty", "conflicting"],
        ["draft", "draft"],
        ["has_hooks", "clean"],
        ["unknown", "unknown"],
        ["something new", "unknown"],
    ])("calls the host's %s state %s", async (state, expected) => {
        const { request } = host({ [`${REPO}/pulls/7`]: { mergeable_state: state }, [REPO]: { allow_merge_commit: true } });

        const merge = await githubDriver.getMergeStatus(request, REF);

        expect(merge.state).toBe(expected);
    });

    it("reports auto-merge as enabled when the pull request has an auto-merge request, and offers nothing a repository does not allow", async () => {
        const { request } = host({ [`${REPO}/pulls/7`]: { auto_merge: { enabled_by: { login: "me" } }, mergeable_state: "clean" }, [REPO]: {} });

        expect(await githubDriver.getMergeStatus(request, REF)).toMatchObject({ autoMergeAllowed: false, autoMergeEnabled: true, methods: [] });
    });
});

describe("mergePullRequest", () => {
    it("is ONE PUT naming the method and the head the person saw", async () => {
        const { request, sent } = host({ [`${REPO}/pulls/7/merge`]: { merged: true, message: "Pull Request successfully merged", sha: "b".repeat(40) } });

        expect(await githubDriver.mergePullRequest(request, REF, { headSha: SHA, method: "squash" })).toEqual({ sha: "b".repeat(40) });
        expect(sent).toEqual([{ json: { merge_method: "squash", sha: SHA }, method: "PUT", path: `${REPO}/pulls/7/merge` }]);
    });

    it("counts a 2xx with a null sha as merged", async () => {
        const { request } = host({ [`${REPO}/pulls/7/merge`]: { merged: true, sha: null } });

        expect(await githubDriver.mergePullRequest(request, REF, { headSha: SHA, method: "squash" })).toEqual({ sha: null });
    });

    it("treats a 2xx that says it did not merge as a refusal with the host's reason", async () => {
        const { request } = host({ [`${REPO}/pulls/7/merge`]: { merged: false, message: "Pull Request is not mergeable" } });

        await expect(githubDriver.mergePullRequest(request, REF, { headSha: SHA, method: "merge" })).rejects.toMatchObject({
            detail: "Pull Request is not mergeable",
            status: 405,
        });
    });

    it("treats a 2xx it cannot read as unconfirmed: the host merged", async () => {
        const { request } = host({ [`${REPO}/pulls/7/merge`]: { nonsense: true } });

        await expect(githubDriver.mergePullRequest(request, REF, { headSha: SHA, method: "merge" })).rejects.toMatchObject({ unconfirmed: true });
    });

    describe("when the merge was already done", () => {
        const pull = (head: string, merged: boolean) => {
            return { head: { sha: head }, merge_commit_sha: "c".repeat(40), merged };
        };

        it.each([405, 409])("answers a %i with the merge that already happened at the same head", async (status) => {
            const { request, sent } = host({
                [`${REPO}/pulls/7/merge`]: new HostApiError("Head branch was modified", status, false, { detail: "Pull Request is not mergeable" }),
                [`${REPO}/pulls/7`]: pull(SHA, true),
            });

            expect(await githubDriver.mergePullRequest(request, REF, { headSha: SHA, method: "merge" })).toEqual({ sha: "c".repeat(40) });
            expect(sent.filter((call) => call.method !== "GET")).toHaveLength(1);
        });

        it("is the same answer when it is asked twice", async () => {
            let merged = false;
            const { request } = host({
                [`${REPO}/pulls/7/merge`]: () => {
                    if (merged) {
                        return new HostApiError("Pull Request is not mergeable", 405, false, { detail: "Pull Request is not mergeable" });
                    }

                    merged = true;

                    return { merged: true, sha: "c".repeat(40) };
                },
                [`${REPO}/pulls/7`]: () => pull(SHA, merged),
            });
            const merge = { headSha: SHA, method: "merge" } as const;

            expect(await githubDriver.mergePullRequest(request, REF, merge)).toEqual({ sha: "c".repeat(40) });
            expect(await githubDriver.mergePullRequest(request, REF, merge)).toEqual({ sha: "c".repeat(40) });
        });

        it("is unconfirmed when the read that would tell cannot be read", async () => {
            const refusal = new HostApiError("no", 409, false, { detail: "Head branch was modified" });

            for (const routes of [
                { [`${REPO}/pulls/7`]: { nonsense: true } },
                { [`${REPO}/pulls/7`]: new HostApiError("slow down", 403, true) },
                { [`${REPO}/pulls/7`]: new HostApiError("down", 502) },
            ]) {
                const { request } = host({ ...routes, [`${REPO}/pulls/7/merge`]: refusal });

                await expect(githubDriver.mergePullRequest(request, REF, { headSha: SHA, method: "merge" })).rejects.toMatchObject({
                    status: 0,
                    unconfirmed: true,
                });
            }
        });

        it("still refuses when it merged a different head, is not merged, or the host answers the read with a refusal", async () => {
            const refusal = new HostApiError("no", 409, false, { detail: "Head branch was modified" });

            for (const routes of [{ [`${REPO}/pulls/7`]: pull("d".repeat(40), true) }, { [`${REPO}/pulls/7`]: pull(SHA, false) }, {}]) {
                const { request } = host({ ...routes, [`${REPO}/pulls/7/merge`]: refusal });

                await expect(githubDriver.mergePullRequest(request, REF, { headSha: SHA, method: "merge" })).rejects.toBe(refusal);
            }
        });

        it("does not look for a merge after a 422, a 403 or a rate limit", async () => {
            for (const error of [new HostApiError("x", 422), new HostApiError("x", 403), new HostApiError("x", 405, true)]) {
                const { request, sent } = host({ [`${REPO}/pulls/7/merge`]: error, [`${REPO}/pulls/7`]: pull(SHA, true) });

                await expect(githubDriver.mergePullRequest(request, REF, { headSha: SHA, method: "merge" })).rejects.toBe(error);
                expect(sent.some((call) => call.method === "GET")).toBe(false);
            }
        });
    });

    it.each(["main", "../x", ""])("refuses %j as a commit id before any request", async (headSha) => {
        const { request, sent } = host({});

        await expect(githubDriver.mergePullRequest(request, REF, { headSha, method: "merge" })).rejects.toMatchObject({ status: 404 });
        expect(sent).toEqual([]);
    });
});

describe("setAutoMerge", () => {
    const graphql = (answer: (sent: Sent) => unknown) =>
        host({
            "/graphql": (sent: Sent) => {
                const query = String(sent.json.query);

                return query.includes("pullRequest(number") ? { data: { repository: { pullRequest: { id: "PR_node" } } } } : answer(sent);
            },
        });

    it("turns auto-merge on with the chosen method", async () => {
        const { request, sent } = graphql(() => {
            return {
                data: { enablePullRequestAutoMerge: { pullRequest: { autoMergeRequest: { enabledAt: "2026-10-30T10:00:00Z" } } } },
            };
        });

        await githubDriver.setAutoMerge(request, REF, true, "rebase", SHA);

        expect(sent.at(-1)?.json.variables).toEqual({ expectedHeadOid: SHA, method: "REBASE", pullRequestId: "PR_node" });
        expect(String(sent.at(-1)?.json.query)).toContain("enablePullRequestAutoMerge");
    });

    it("refuses a head that is not a commit id before any request when turning it on", async () => {
        const { request, sent } = graphql(() => {
            return {};
        });

        await expect(githubDriver.setAutoMerge(request, REF, true, "merge", "main")).rejects.toMatchObject({ status: 404 });
        expect(sent).toEqual([]);
    });

    it("turns it off", async () => {
        const { request, sent } = graphql(() => {
            return { data: { disablePullRequestAutoMerge: { pullRequest: { autoMergeRequest: null } } } };
        });

        await githubDriver.setAutoMerge(request, REF, false, "merge", SHA);

        expect(sent.at(-1)?.json.variables).toEqual({ pullRequestId: "PR_node" });
    });

    it("does not call it done when the host answers without the state asked for", async () => {
        const { request } = graphql(() => {
            return { data: { enablePullRequestAutoMerge: { pullRequest: { autoMergeRequest: null } } } };
        });

        await expect(githubDriver.setAutoMerge(request, REF, true, "merge", SHA)).rejects.toBeInstanceOf(HostApiError);
    });

    it("carries the host's reason when it refuses", async () => {
        const { request } = graphql(() => {
            return { errors: [{ message: "Pull request is in clean status", type: "UNPROCESSABLE" }] };
        });

        await expect(githubDriver.setAutoMerge(request, REF, true, "merge", SHA)).rejects.toMatchObject({
            detail: "Pull request is in clean status",
            status: 422,
        });
    });
});

describe("what a person is told when the host's rules refuse", () => {
    const token = {
        accessToken: "tkn",
        renew: async () => {
            return { problem: "expired" as const };
        },
    };
    const via = (answer: () => Response) => async () => answer();

    it("keeps the host's reason for a merge its branch rules refuse", async () => {
        const outcome = await writeToHost(
            githubDriver,
            token,
            async (request) => await githubDriver.mergePullRequest(request, REF, { headSha: SHA, method: "merge" }),
            via(() => Response.json({ message: 'Required status check "build" is expected.' }, { status: 405 })),
        );

        expect(outcome).toEqual({ reason: 'Required status check "build" is expected.', status: "rejected" });
    });

    it("keeps the reason when the head moved since the person looked", async () => {
        const outcome = await writeToHost(
            githubDriver,
            token,
            async (request) => await githubDriver.mergePullRequest(request, REF, { headSha: SHA, method: "merge" }),
            via(() => Response.json({ message: "Head branch was modified. Review and try the merge again." }, { status: 409 })),
        );

        expect(outcome).toEqual({ reason: "Head branch was modified. Review and try the merge again.", status: "rejected" });
    });

    it("keeps the reason of a refusal that arrives as a 2xx with merged: false", async () => {
        const outcome = await writeToHost(
            githubDriver,
            token,
            async (request) => await githubDriver.mergePullRequest(request, REF, { headSha: SHA, method: "merge" }),
            via(() => Response.json({ merged: false, message: "Pull Request is not mergeable" })),
        );

        expect(outcome).toEqual({ reason: "Pull Request is not mergeable", status: "rejected" });
    });

    it("keeps the reason of a re-run the host refuses with a 403, and says forbidden for a bare one", async () => {
        const rerun = async (response: Response) =>
            await writeToHost(
                githubDriver,
                token,
                async (request) => {
                    await githubDriver.rerunCheck(request, REF, "55");

                    return {};
                },
                async (url) => (String(url).includes("/rerun") ? response : Response.json(run(55, "build"))),
            );

        expect(await rerun(Response.json({ message: "Cannot re-run a job while others in the run are in progress" }, { status: 403 }))).toEqual({
            reason: "Cannot re-run a job while others in the run are in progress",
            status: "rejected",
        });
        expect(await rerun(new Response(null, { status: 403 }))).toEqual({ status: "forbidden" });
    });

    it("says rate_limited, not no access, when the merge is throttled", async () => {
        const outcome = await writeToHost(
            githubDriver,
            token,
            async (request) => await githubDriver.mergePullRequest(request, REF, { headSha: SHA, method: "merge" }),
            via(() => Response.json({ message: "You have exceeded a secondary rate limit." }, { status: 403 })),
        );

        expect(outcome).toEqual({ status: "rate_limited" });
    });
});

describe("the newest reviews", () => {
    it("finds the last page a Link header names", () => {
        expect(
            lastPageOf(
                '<https://api.github.com/repositories/1/pulls/7/reviews?page=2&per_page=100>; rel="next", <https://api.github.com/repositories/1/pulls/7/reviews?page=4&per_page=100>; rel="last"',
            ),
        ).toBe(4);
        expect(lastPageOf(null)).toBeUndefined();
        expect(lastPageOf('<https://api.github.com/x?page=2>; rel="next"')).toBeUndefined();
    });
});

const REVIEW_BY_ID = /\/reviews\/(?<id>\d+)$/u;

describe("reading past the first page", () => {
    /** A host that answers by path and page: `pages[path][page - 1]` is that page's body, with an optional Link header. */
    const paged =
        (pages: Record<string, { body: unknown; link?: string }[]>): HostRequest =>
        async (path, options: HostRequestOptions = {}) => {
            const page = Number(options.query?.page ?? 1);
            const answer = pages[path]?.[page - 1];

            if (answer === undefined) {
                throw new HostApiError(`no route ${path} page ${String(page)}`, 404);
            }

            return Response.json(answer.body, { headers: answer.link === undefined ? {} : { link: answer.link } });
        };

    it("lists every page of checks a reader asks for, so a failure on a later page is not missed", async () => {
        const runs = (from: number, count: number, conclusion = "success") =>
            Array.from({ length: count }, (_, index) => run(from + index, `job ${String(from + index)}`, conclusion));
        const request = paged({
            [`${REPO}/branches/main`]: [{ body: { protected: false } }],
            [`${REPO}/commits/${SHA}/check-runs`]: [
                { body: { check_runs: runs(1, 100), total_count: 150 } },
                { body: { check_runs: runs(101, 50, "failure"), total_count: 150 } },
            ],
            [`${REPO}/commits/${SHA}/status`]: [{ body: { statuses: [], total_count: 0 } }],
            [`${REPO}/pulls/7`]: [{ body: { base: { ref: "main" } } }],
            [`${REPO}/rules/branches/main`]: [{ body: [] }],
        });

        const one = await githubDriver.listChecks(request, REF, SHA);
        const all = await githubDriver.listChecks(request, REF, SHA, 10);

        expect(one.checks).toHaveLength(100);
        expect(all.checks).toHaveLength(150);
        expect(all.checks.filter((check) => check.state === "failure")).toHaveLength(50);
    });

    it("reads the newest reviews from the last page and hands them over newest first, with the total", async () => {
        const review = (id: number) => {
            return {
                body: `r${String(id)}`,
                id,
                state: "COMMENTED",
                submitted_at: new Date(Date.UTC(2026, 0, 1, 0, 0, id)).toISOString(),
                user: { login: "x" },
            };
        };
        const link = `<https://api.github.com/repositories/1/pulls/7/reviews?page=2&per_page=100>; rel="next", <https://api.github.com/repositories/1/pulls/7/reviews?page=3&per_page=100>; rel="last"`;
        const request = paged({
            [`${REPO}/pulls/7/reviews`]: [
                { body: Array.from({ length: 100 }, (_, index) => review(index + 1)), link },
                { body: Array.from({ length: 100 }, (_, index) => review(index + 101)) },
                { body: Array.from({ length: 20 }, (_, index) => review(index + 201)) },
            ],
        });

        const reviews = await githubDriver.listReviews(request, REF);

        expect(reviews.total).toBe(220);
        expect(reviews.items[0]?.body).toBe("r220");
        expect(reviews.items.at(-1)?.body).toBe("r101");
    });

    describe("a full read for a watch (readAll)", () => {
        const at = (id: number, seconds: number) => {
            return {
                body: `r${String(id)}`,
                id,
                state: "COMMENTED",
                submitted_at: new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)).toISOString(),
                user: { login: "x" },
            };
        };
        const pageOf = (from: number, count: number, submittedAt = (id: number) => id) =>
            Array.from({ length: count }, (_, index) => at(from + index, submittedAt(from + index)));
        const linkTo = (last: number) =>
            `<https://api.github.com/repositories/1/pulls/7/reviews?page=2&per_page=100>; rel="next", <https://api.github.com/repositories/1/pulls/7/reviews?page=${String(last)}&per_page=100>; rel="last"`;
        const counted = (pages: { body: unknown; link?: string }[]) => {
            const requests: number[] = [];
            const request: HostRequest = async (_path, options: HostRequestOptions = {}) => {
                const page = Number(options.query?.page ?? 1);

                requests.push(page);

                return Response.json(pages[page - 1]?.body, { headers: page === 1 && pages[0]?.link !== undefined ? { link: pages[0].link } : {} });
            };

            return { request, requests };
        };

        it("makes exactly one request for a PR with less than a page of reviews", async () => {
            const { request, requests } = counted([{ body: pageOf(1, 30) }]);
            const reviews = await githubDriver.listReviews(request, REF, { readAll: true });

            expect(requests).toEqual([1]);
            expect(reviews.items).toHaveLength(30);
        });

        it("reads every page when the list fits under the bound, so a review created early and submitted late is listed first", async () => {
            // Review 40 sits on page 1 (created early) but was submitted after everything else.
            const pages = [{ body: pageOf(1, 100, (id) => (id === 40 ? 9999 : id)), link: linkTo(3) }, { body: pageOf(101, 100) }, { body: pageOf(201, 20) }];
            const { request, requests } = counted(pages);
            const reviews = await githubDriver.listReviews(request, REF, { readAll: true, seenId: "150" });

            expect(requests).toEqual([1, 2, 3]);
            expect(reviews.total).toBe(220);
            expect(reviews.items[0]?.id).toBe("40");
        });

        it("keeps the first page it read when it falls back, so the newest reviews of page 1 are not dropped", async () => {
            const last = 12;
            const pages = Array.from({ length: last }, (_, index) => {
                // Review 55 on page 1 was submitted after everything else.
                return { body: pageOf(index * 100 + 1, 100, (id) => (id === 55 ? 99_999 : id)), ...(index === 0 && { link: linkTo(last) }) };
            });
            const { request, requests } = counted(pages);
            const reviews = await githubDriver.listReviews(request, REF, { readAll: true });

            expect(requests).toEqual([1, last]);
            expect(reviews.items[0]?.id).toBe("55");
            expect(new Set(reviews.items.map((item) => item.id)).size).toBe(reviews.items.length);
        });

        describe("on a PR past the page bound, with a seen review", () => {
            // Review n is on page ceil(n / 100) and was submitted at second n: creation and submission agree unless a test says otherwise.
            const longList = (last: number, submittedAt = (id: number) => id, noTime = new Set<number>()) => {
                const requests: string[] = [];
                const request: HostRequest = async (path, options: HostRequestOptions = {}) => {
                    const lookup = REVIEW_BY_ID.exec(path)?.groups?.id;

                    if (lookup !== undefined) {
                        requests.push(`review ${lookup}`);

                        return Response.json({ submitted_at: new Date(Date.UTC(2026, 0, 1, 0, 0, submittedAt(Number(lookup)))).toISOString() });
                    }

                    const page = Number(options.query?.page ?? 1);

                    requests.push(`page ${String(page)}`);

                    // A review in `noTime` has a verdict but no submission time.
                    const body = pageOf((page - 1) * 100 + 1, 100, submittedAt).map((review) =>
                        noTime.has(review.id) ? { ...review, submitted_at: null } : review,
                    );

                    return Response.json(body, { headers: page === 1 ? { link: linkTo(last) } : {} });
                };

                return { request, requests };
            };

            it("walks the full budget on every poll, so a review submitted late on an earlier page inside it is found", async () => {
                // Review 9150 (page 92) was submitted after the seen review 9950 (page 100), whatever its position.
                const seenAt = 9950;
                const late = (id: number) => (id === 9150 ? 20_000 : id);

                for (let poll = 0; poll < 2; poll += 1) {
                    const { request, requests } = longList(100, late);
                    const reviews = await githubDriver.listReviews(request, REF, { readAll: true, seenId: String(seenAt) });

                    // The first page, the seen review's time, then ten pages from the last (100 down to 91), every time.
                    expect(requests).toHaveLength(12);
                    expect(requests.slice(2)).toEqual(Array.from({ length: 10 }, (_, index) => `page ${String(100 - index)}`));
                    expect(reviews.items[0]?.id).toBe("9150");
                }
            });

            it("does not end the walk at a page of reviews with no submission time, and a review with no time is not newer", async () => {
                // Pages 100 and 99 hold only reviews with no time; a late-submitted review sits on page 95, inside the budget.
                const noTime = new Set(Array.from({ length: 200 }, (_, index) => 9801 + index));
                const { request, requests } = longList(100, (id) => (id === 9450 ? 20_000 : id), noTime);
                const reviews = await githubDriver.listReviews(request, REF, { readAll: true, seenId: "9950" });

                expect(requests).toHaveLength(12);
                expect(reviews.items.some((item) => item.id === "9450")).toBe(true);
                // The no-time reviews come back with no time (0): they sort last and never order as newer than the seen review.
                expect(reviews.items.filter((item) => item.submittedAt === 0).length).toBeGreaterThan(0);
                expect(reviews.items[0]?.id).toBe("9450");
            });

            it("never reads more than the budget when the seen review is far back, and still hands over the newest reviews", async () => {
                const { request, requests } = longList(100);
                const reviews = await githubDriver.listReviews(request, REF, { readAll: true, seenId: "10" });

                // The first page, the seen review's time, then the budget of ten pages from the last: 12 requests, never 100.
                expect(requests).toHaveLength(12);
                expect(requests.slice(-1)).toEqual(["page 91"]);
                expect(reviews.items[0]?.id).toBe("10000");
                // Only the first page and the newest ten pages: nothing from the middle.
                expect(reviews.items.some((item) => item.id === "5000")).toBe(false);
            });

            it("falls back to the plain newest-pages read when the seen review's time cannot be read", async () => {
                const request: HostRequest = async (path, options: HostRequestOptions = {}) => {
                    if (REVIEW_BY_ID.test(path)) {
                        throw new HostApiError("not found", 404);
                    }

                    const page = Number(options.query?.page ?? 1);

                    return Response.json(pageOf((page - 1) * 100 + 1, 100), { headers: page === 1 ? { link: linkTo(100) } : {} });
                };
                const reviews = await githubDriver.listReviews(request, REF, { readAll: true, seenId: "50" });

                expect(reviews.items[0]?.id).toBe("10000");
            });
        });

        it("falls back to the newest pages without an error when there are more pages than the bound", async () => {
            const last = 12;
            const pages = Array.from({ length: last }, (_, index) => {
                return { body: pageOf(index * 100 + 1, 100), ...(index === 0 && { link: linkTo(last) }) };
            });
            const { request, requests } = counted(pages);
            const reviews = await githubDriver.listReviews(request, REF, { readAll: true, seenId: "50" });

            // Never the whole list: the first page, the last, the one before, then back to the seen one within the usual budget.
            expect(requests.length).toBeLessThanOrEqual(5);
            expect(requests).toContain(last);
            expect(reviews.total).toBe(1200);
            expect(reviews.items[0]?.id).toBe("1200");
        });
    });

    it("goes back through earlier pages until the seen review is listed, within a bound", async () => {
        const page = (from: number, count: number) =>
            Array.from({ length: count }, (_, index) => {
                const id = from + index;

                return {
                    body: `r${String(id)}`,
                    id,
                    state: "COMMENTED",
                    submitted_at: new Date(Date.UTC(2026, 0, 1, 0, 0, id)).toISOString(),
                    user: { login: "x" },
                };
            });
        const link = `<https://api.github.com/repositories/1/pulls/7/reviews?page=2&per_page=100>; rel="next", <https://api.github.com/repositories/1/pulls/7/reviews?page=5&per_page=100>; rel="last"`;
        // Reads in order: the first page, the last, the one before it, then one earlier page at a time.
        const request = () =>
            paged({
                [`${REPO}/pulls/7/reviews`]: [
                    { body: page(1, 100), link },
                    { body: page(401, 20) },
                    { body: page(301, 100) },
                    { body: page(201, 100) },
                    { body: page(101, 100) },
                ],
            });

        const found = await githubDriver.listReviews(request(), REF, { seenId: "250" });
        const without = await githubDriver.listReviews(request(), REF);
        const absent = await githubDriver.listReviews(request(), REF, { seenId: "9999" });

        expect(found.items.some((item) => item.id === "250")).toBe(true);
        expect(without.items.some((item) => item.id === "250")).toBe(false);
        // Never found: the read stops at the bound (5 pages in all, the first included), not at the end of the list.
        expect(absent.items.some((item) => item.id === "101")).toBe(true);
    });
});

describe("the review count", () => {
    it("leaves a draft out of the total as well as the list", async () => {
        const request: HostRequest = async () =>
            Response.json([
                { body: "seen", id: 1, state: "APPROVED", submitted_at: "2026-01-01T00:00:00Z", user: { login: "a" } },
                { body: "mine, not sent", id: 2, state: "PENDING", submitted_at: null, user: { login: "me" } },
            ]);

        const reviews = await githubDriver.listReviews(request, REF);

        expect(reviews).toMatchObject({ items: [{ body: "seen" }], total: 1 });
    });

    it("puts the later of two reviews sent in the same second first, and keeps the reviewer's standing", async () => {
        const at = "2026-01-01T00:00:00Z";
        const request: HostRequest = async () =>
            Response.json([
                { author_association: "MEMBER", body: "fine", id: 10, state: "APPROVED", submitted_at: at, user: { login: "ann" } },
                { author_association: "MEMBER", body: "on second thought", id: 11, state: "CHANGES_REQUESTED", submitted_at: at, user: { login: "ann" } },
            ]);

        const reviews = await githubDriver.listReviews(request, REF);

        expect(reviews.items.map((review) => [review.body, review.authorAssociation])).toStrictEqual([
            ["on second thought", "MEMBER"],
            ["fine", "MEMBER"],
        ]);
    });

    it("hands over the reviewer's id, and no name for a deleted account", async () => {
        const at = "2026-01-01T00:00:00Z";
        const request: HostRequest = async () =>
            Response.json([
                { body: "a", id: 10, state: "APPROVED", submitted_at: at, user: { id: 42, login: "ann" } },
                { body: "b", id: 11, state: "CHANGES_REQUESTED", submitted_at: at, user: null },
            ]);

        const reviews = await githubDriver.listReviews(request, REF);

        expect(reviews.items.map((review) => [review.authorId, review.authorLogin])).toStrictEqual([
            [undefined, ""],
            ["42", "ann"],
        ]);
    });
});

describe("a check log read inside a time budget", () => {
    it("gives every request of the read no more than the budget it was handed", async () => {
        const timeouts: (number | undefined)[] = [];
        const request: HostRequest = async (path, options: HostRequestOptions = {}) => {
            timeouts.push(options.timeoutMs);

            if (path.endsWith("/check-runs/11")) {
                return Response.json({ app: { slug: "github-actions" }, output: { summary: "1 failed", title: "Tests" } });
            }

            // The log answer: refused, so the read falls back to the check's own output.
            throw new HostApiError("Forbidden", 403);
        };

        const log = await githubDriver.readCheckLog(request, REF, "11", 1000, 3000);

        expect(log.source).toBe("check_output");
        expect(timeouts).toHaveLength(2);
        expect(timeouts.every((timeout) => timeout !== undefined && timeout <= 3000)).toBe(true);
    });
});

describe("a check log read that runs out of time", () => {
    it("falls back to the check's own output when the log request times out", async () => {
        const request: HostRequest = async (path) => {
            if (path.endsWith("/check-runs/11")) {
                return Response.json({ app: { slug: "github-actions" }, output: { summary: "1 failed", title: "Tests" } });
            }

            // The log request's deadline fired: the requester reports a request that did not complete.
            throw new HostApiError("The host could not be reached", 0);
        };

        await expect(githubDriver.readCheckLog(request, REF, "11", 1000, 50)).resolves.toMatchObject({ source: "check_output" });
    });

    it("falls back to the check's own output when a log answered in place is cut off before its first byte", async () => {
        const request: HostRequest = async (path) => {
            if (path.endsWith("/check-runs/11")) {
                return Response.json({ app: { slug: "github-actions" }, output: { summary: "1 failed", title: "Tests" } });
            }

            // The log answered in place, its body cut off by the deadline before a byte arrived.
            return new Response(
                new ReadableStream({
                    pull(controller) {
                        controller.error(new DOMException("The operation timed out", "TimeoutError"));
                    },
                }),
            );
        };

        await expect(githubDriver.readCheckLog(request, REF, "11", 1000, 50)).resolves.toMatchObject({ source: "check_output" });
    });
});
