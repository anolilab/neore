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
import { githubDriver } from "./github";

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
                { type: "pull_request" },
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

    it("refuses a base branch that is not a branch name before it reaches a path", async () => {
        const { request, sent } = host({ ...checksRoutes([run(1, "build")]), [`${REPO}/pulls/7`]: { base: { ref: "main/../../admin" } } });

        await expect(githubDriver.listChecks(request, REF, SHA)).rejects.toMatchObject({ status: 404 });
        expect(sent.some((call) => call.path.includes("admin"))).toBe(false);
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

        await githubDriver.setAutoMerge(request, REF, true, "rebase");

        expect(sent.at(-1)?.json.variables).toEqual({ method: "REBASE", pullRequestId: "PR_node" });
        expect(String(sent.at(-1)?.json.query)).toContain("enablePullRequestAutoMerge");
    });

    it("turns it off", async () => {
        const { request, sent } = graphql(() => {
            return { data: { disablePullRequestAutoMerge: { pullRequest: { autoMergeRequest: null } } } };
        });

        await githubDriver.setAutoMerge(request, REF, false, "merge");

        expect(sent.at(-1)?.json.variables).toEqual({ pullRequestId: "PR_node" });
    });

    it("does not call it done when the host answers without the state asked for", async () => {
        const { request } = graphql(() => {
            return { data: { enablePullRequestAutoMerge: { pullRequest: { autoMergeRequest: null } } } };
        });

        await expect(githubDriver.setAutoMerge(request, REF, true, "merge")).rejects.toBeInstanceOf(HostApiError);
    });

    it("carries the host's reason when it refuses", async () => {
        const { request } = graphql(() => {
            return { errors: [{ message: "Pull request is in clean status", type: "UNPROCESSABLE" }] };
        });

        await expect(githubDriver.setAutoMerge(request, REF, true, "merge")).rejects.toMatchObject({ detail: "Pull request is in clean status", status: 422 });
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
