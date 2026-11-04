/**
 * The GitHub driver's pull request actions (edit, request reviewers, revert) against recorded
 * GraphQL answers, not live GitHub. Each action names the pull request by its node id, is one
 * mutation, and refuses an answer that does not confirm the change.
 */
import { describe, expect, it } from "vitest";

import { HostApiError } from "../origin-fetch";
import type { HostRequest, HostRequestOptions } from "../origin-fetch";
import { githubDriver } from "./github";

const REF = { number: 7, repository: "octo/hello" };

interface Sent {
    json: any;
    method: string;
    path: string;
}

/** A host that answers `/graphql`: the node-id lookup is answered here, every mutation by `answer`. */
const graphql = (answer: (sent: Sent) => unknown) => {
    const sent: Sent[] = [];
    const request: HostRequest = async (path, options: HostRequestOptions = {}) => {
        const call: Sent = { json: options.json, method: options.method ?? "GET", path };

        sent.push(call);

        if (path !== "/graphql") {
            throw new HostApiError(`no route ${path}`, 404);
        }

        const query = String(call.json.query);

        if (query.includes("pullRequest(number")) {
            return Response.json({ data: { repository: { pullRequest: { id: "PR_node" } } } });
        }

        const body = answer(call);

        if (body instanceof HostApiError) {
            throw body;
        }

        return Response.json(body);
    };

    return { request, sent };
};

describe("editPullRequest", () => {
    it("is ONE mutation that names the node and sends only the fields given", async () => {
        const { request, sent } = graphql(() => {
            return { data: { updatePullRequest: { pullRequest: { body: null, id: "PR_node", title: "New" } } } };
        });

        await githubDriver.editPullRequest(request, REF, { title: "New" });

        const mutation = sent.find((call) => String(call.json.query).includes("updatePullRequest"));

        expect(mutation?.json.variables).toEqual({ body: undefined, pullRequestId: "PR_node", title: "New" });
    });

    it("counts an answer without the pull request as unconfirmed", async () => {
        const { request } = graphql(() => {
            return { data: { updatePullRequest: null } };
        });

        await expect(githubDriver.editPullRequest(request, REF, { title: "New" })).rejects.toMatchObject({ unconfirmed: true });
    });

    it("counts a title the host did not keep as unconfirmed", async () => {
        const { request } = graphql(() => {
            return { data: { updatePullRequest: { pullRequest: { id: "PR_node", title: "Old" } } } };
        });

        await expect(githubDriver.editPullRequest(request, REF, { title: "New" })).rejects.toMatchObject({ unconfirmed: true });
    });
});

describe("requestReviewers", () => {
    it("accepts a managed-user login with an underscore", async () => {
        const { request, sent } = graphql(() => {
            return { data: { requestReviewsByLogin: { pullRequest: { id: "PR_node" } } } };
        });

        await githubDriver.requestReviewers(request, REF, ["octo_shortcode"]);

        expect(sent.some((call) => String(call.json.query).includes("requestReviewsByLogin"))).toBe(true);
    });

    it("adds the logins to the ones already requested (union) in one mutation", async () => {
        const { request, sent } = graphql(() => {
            return { data: { requestReviewsByLogin: { pullRequest: { id: "PR_node" } } } };
        });

        await githubDriver.requestReviewers(request, REF, ["alice", "bob-2"]);

        const mutation = sent.find((call) => String(call.json.query).includes("requestReviewsByLogin"));

        expect(String(mutation?.json.query)).toContain("union: true");
        expect(mutation?.json.variables).toEqual({ logins: ["alice", "bob-2"], pullRequestId: "PR_node" });
    });

    it.each([["-leading"], ["trailing-"], ["a--b"], ["has space"], ["x".repeat(40)]])("refuses a login the host would not accept: %s", async (login) => {
        const { request, sent } = graphql(() => {
            return { data: {} };
        });

        await expect(githubDriver.requestReviewers(request, REF, [login])).rejects.toMatchObject({ status: 422 });
        expect(sent.some((call) => String(call.json.query).includes("requestReviewsByLogin"))).toBe(false);
    });

    it("refuses more logins than one call may add", async () => {
        const { request } = graphql(() => {
            return { data: {} };
        });
        const many = Array.from({ length: 16 }, (_, index) => `user${index}`);

        await expect(githubDriver.requestReviewers(request, REF, many)).rejects.toMatchObject({ status: 422 });
    });
});

describe("editPullRequest body", () => {
    it("counts a description the host kept differently as unconfirmed", async () => {
        const { request } = graphql(() => {
            return { data: { updatePullRequest: { pullRequest: { body: "kept", id: "PR_node", title: "New" } } } };
        });

        await expect(githubDriver.editPullRequest(request, REF, { body: "asked" })).rejects.toMatchObject({ unconfirmed: true });
    });

    it("accepts a description that differs only in line endings", async () => {
        const { request } = graphql(() => {
            return { data: { updatePullRequest: { pullRequest: { body: "one\r\ntwo", id: "PR_node", title: "New" } } } };
        });

        await expect(githubDriver.editPullRequest(request, REF, { body: "one\ntwo" })).resolves.toBeUndefined();
    });
});

describe("a host answer that cannot be read after an accepted change", () => {
    it("is unconfirmed for a revert, never a plain failure a retry would repeat", async () => {
        const { request } = graphql(() => new HostApiError("unreadable", 0));

        await expect(githubDriver.revertPullRequest(request, REF, {})).rejects.toMatchObject({ unconfirmed: true });
    });

    it("keeps a real refusal as a refusal", async () => {
        const { request } = graphql(() => new HostApiError("refused", 422, false, { detail: "Pull request is not merged" }));

        await expect(githubDriver.revertPullRequest(request, REF, {})).rejects.toMatchObject({ status: 422, unconfirmed: false });
    });
});

describe("revertPullRequest", () => {
    it("returns the revert pull request in the same repository", async () => {
        const { request } = graphql(() => {
            return {
                data: { revertPullRequest: { revertPullRequest: { number: 12, url: "https://github.com/octo/hello/pull/12" } } },
            };
        });

        expect(await githubDriver.revertPullRequest(request, REF, {})).toEqual({
            number: 12,
            repository: "octo/hello",
            url: "https://github.com/octo/hello/pull/12",
        });
    });

    it("counts a link that is not on the web origin as unconfirmed, never shown", async () => {
        const { request } = graphql(() => {
            return { data: { revertPullRequest: { revertPullRequest: { number: 12, url: "https://evil.example/pull/12" } } } };
        });

        await expect(githubDriver.revertPullRequest(request, REF, {})).rejects.toMatchObject({ unconfirmed: true });
    });

    it("passes a host refusal (an unmerged pull request) through as a refusal", async () => {
        const { request } = graphql(() => new HostApiError("The host refused the GraphQL request", 422, false, { detail: "Pull request is not merged" }));

        await expect(githubDriver.revertPullRequest(request, REF, {})).rejects.toMatchObject({ status: 422 });
    });
});

describe("pull request action capabilities", () => {
    it("declares the three actions", () => {
        expect(githubDriver.view.capabilities.groups.pullRequest).toMatchObject({ edit: { supported: true }, revert: { supported: true } });
        expect(githubDriver.view.capabilities.groups.reviewers).toMatchObject({ request: { supported: true } });
    });
});
