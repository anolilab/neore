/** A failed refresh keeps the page a write was made on; only a page that never loaded is replaced by the failure notice. */

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import PullRequestView from "./pull-request-view";

const { pull } = vi.hoisted(() => {
    return { pull: { current: {} as Record<string, unknown> } };
});

vi.mock("@lingui/core/macro", () => {
    return { plural: (_count: number, forms: { other: string }) => forms.other };
});

vi.mock("@lingui/react/macro", () => {
    const text = (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values);

    return {
        useLingui: () => {
            return { i18n: { _: String, locale: "en" }, t: text };
        },
    };
});

vi.mock("@neore/backend/source-control/capabilities", () => {
    return { isHostCapabilityAvailable: () => false };
});

vi.mock("../lib/use-develop", () => {
    return { usePullRequest: () => pull.current };
});

vi.mock("../lib/use-request-noun", () => {
    return { useRequestNoun: () => "pull request" };
});

vi.mock("./failure-notice", () => {
    return { default: () => <p>Failure notice</p> };
});

vi.mock("./checks-tab", () => {
    return { default: () => null };
});

vi.mock("./commits-tab", () => {
    return { default: () => null };
});

vi.mock("./files-tab", () => {
    return { default: () => null };
});

vi.mock("./guide-tab", () => {
    return { default: () => null };
});

vi.mock("./merge-panel", () => {
    return { default: () => null };
});

vi.mock("./pull-request-actions-panel", () => {
    return { default: () => null };
});

vi.mock("./review-panel", () => {
    return { default: () => null };
});

vi.mock("./work-on-pull-request", () => {
    return { default: () => null };
});

const detail = {
    additions: 1,
    authorLogin: "alice",
    baseBranch: "main",
    body: "",
    bodyTruncated: false,
    changedFiles: 1,
    commitCount: 1,
    deletions: 0,
    draft: false,
    headBranch: "feature",
    headSha: "abc",
    number: 7,
    repository: "octo/hello",
    state: "open",
    title: "Saved title",
    url: "https://github.com/octo/hello/pull/7",
};

const renderView = () =>
    render(
        <PullRequestView
            host={{ capabilities: {}, label: "GitHub", requestNoun: "pull request" } as never}
            number={7}
            onTabChange={() => {}}
            repository="octo/hello"
            tab={undefined}
        />,
    );

describe("PullRequestView refresh failure", () => {
    it("keeps the page and says it may be out of date when a refetch fails", () => {
        pull.current = { data: { detail, leftOut: [], status: "ok" }, isError: true };
        renderView();

        expect(screen.getByText("Saved title")).toBeTruthy();
        expect(screen.queryByText("Failure notice")).toBeNull();
        expect(screen.getByRole("status").textContent).toContain("out of date");
    });

    it("shows the failure notice when the page never loaded", () => {
        pull.current = { data: undefined, isError: true };
        renderView();

        expect(screen.getByText("Failure notice")).toBeTruthy();
    });
});
