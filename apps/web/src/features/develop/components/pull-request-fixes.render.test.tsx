/**
 * The header shows what blocks a linked open pull request, with one action per problem; the action only writes a
 * prompt into the thread's composer.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import PullRequestFixes from "./pull-request-fixes";

const { prefill, status } = vi.hoisted(() => {
    return { prefill: vi.fn(), status: { current: {} as { data?: Record<string, unknown> } } };
});

// The unit-test transform does not compile Lingui macros (vi.mock is hoisted).
vi.mock("@lingui/react/macro", () => {
    const text = (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values);

    return {
        useLingui: () => {
            return { i18n: { _: (descriptor: { id?: string }) => descriptor.id ?? "" }, t: text };
        },
    };
});

vi.mock("@lingui/core/macro", () => {
    return {
        msg: (strings: TemplateStringsArray, ...values: unknown[]) => {
            return { id: String.raw({ raw: strings }, ...values) };
        },
    };
});

vi.mock("@/features/chat/thread/composer-prefill", () => {
    return { prefillComposer: prefill };
});

vi.mock("../lib/use-develop", () => {
    return { usePullRequestStatus: () => status.current };
});

const open = (overrides: Record<string, unknown>) => {
    status.current = {
        data: {
            baseBranch: "main",
            changeRequests: [],
            changeRequestsMore: 0,
            conflicting: false,
            failingChecks: [],
            failingChecksMore: 0,
            headBranch: "feat/x",
            headSha: "a".repeat(40),
            number: 7,
            repository: "octo/hello",
            state: "open",
            status: "ok",
            title: "Add x",
            unlistedChecks: 0,
            url: "https://github.com/octo/hello/pull/7",
            ...overrides,
        },
    };
};

const renderFixes = () => render(<PullRequestFixes address={{ number: 7, repository: "octo/hello" }} threadId="thread-1" />);

describe(PullRequestFixes, () => {
    beforeEach(() => {
        prefill.mockReset();
        // The popover positions itself with a ResizeObserver, which jsdom lacks.
        vi.stubGlobal(
            "ResizeObserver",
            class {
                public disconnect = vi.fn();

                public observe = vi.fn();

                public unobserve = vi.fn();
            },
        );
    });

    it("shows nothing for a pull request with no problems, a merged one, or one the host could not read", () => {
        for (const data of [undefined, { state: "merged", status: "ok" }, { status: "rate_limited" }]) {
            status.current = { data };

            const { unmount } = renderFixes();

            expect(screen.queryByRole("button")).toBeNull();

            unmount();
        }

        open({});

        renderFixes();

        expect(screen.queryByRole("button")).toBeNull();
    });

    it("lists each problem with its action, and an action only fills the composer", async () => {
        open({ changeRequests: [{ authorLogin: "rev", body: "Rename it.", bodyTruncated: false }], conflicting: true, failingChecks: ["lint"] });
        renderFixes();

        fireEvent.click(screen.getByRole("button", { name: "Problems on octo/hello#7: 3" }));

        expect(await screen.findByText("Failing checks: lint")).toBeDefined();
        expect(screen.getByText("Conflicts with main")).toBeDefined();
        expect(screen.getByText("Changes requested by rev")).toBeDefined();

        expect(screen.getByRole("button", { name: "Fix checks" })).toBeDefined();
        expect(screen.getByRole("button", { name: "Address review" })).toBeDefined();

        fireEvent.click(screen.getByRole("button", { name: "Resolve conflicts" }));

        expect(prefill).toHaveBeenCalledTimes(1);
        expect(prefill).toHaveBeenCalledWith("thread-1", expect.stringContaining("Resolve the merge conflicts between pull request octo/hello#7"));
    });
});
