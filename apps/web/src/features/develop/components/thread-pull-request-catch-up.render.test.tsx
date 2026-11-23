/**
 * The Catch up control shows only for an open linked pull request the host reports as behind its base, and fills the
 * thread's composer without sending.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import ThreadPullRequestCatchUp from "./thread-pull-request-catch-up";

const { composer, merge, prefill, pull } = vi.hoisted(() => {
    return {
        composer: { takes: true },
        merge: { current: {} as { data?: { state: string; status: string }; isError?: boolean } },
        prefill: vi.fn(),
        pull: { current: {} as { data?: { detail?: { baseBranch: string; headBranch: string; state: string }; status: string }; isError?: boolean } },
    };
});

// The unit-test transform does not compile Lingui macros (vi.mock is hoisted).
vi.mock("@lingui/react/macro", () => {
    const text = (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values);

    return {
        useLingui: () => {
            return { t: text };
        },
    };
});

// Mirrors the real TooltipTrigger: with `render`, the element is the trigger and its children are not forwarded into it.
vi.mock("@neore/ui/components/tooltip", () => {
    return {
        Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
        TooltipContent: () => null,
        TooltipTrigger: ({ render: element }: { render: ReactElement<{ children?: ReactNode }> }) => <element.type {...element.props} />,
    };
});

vi.mock("@/features/chat/thread/composer-prefill", () => {
    return { prefillComposer: prefill, useComposerTakesPrefill: () => composer.takes };
});

vi.mock("../lib/use-develop", () => {
    return { usePullRequest: () => pull.current };
});

vi.mock("../lib/use-merge", () => {
    return { useMergeStatus: () => merge.current };
});

const BUTTON = { name: "Catch up octo/hello#7 with main" };

const given = (state: string, mergeState: string, headBranch = "feat/x") => {
    pull.current = { data: { detail: { baseBranch: "main", headBranch, state }, status: "ok" } };
    merge.current = { data: { state: mergeState, status: "ok" } };
};

const renderCatchUp = () => render(<ThreadPullRequestCatchUp link={{ number: 7, repository: "octo/hello" }} threadId="thread-1" />);

describe("ThreadPullRequestCatchUp", () => {
    beforeEach(() => {
        prefill.mockClear();
        composer.takes = true;
    });

    it("shows Behind <base> and fills the composer with the rebase prompt, without sending", () => {
        given("open", "behind");
        renderCatchUp();

        expect(screen.getByText("Behind main")).toBeTruthy();

        const button = screen.getByRole("button", BUTTON);

        expect(button.textContent).toBe("Catch up");

        fireEvent.click(button);

        expect(prefill).toHaveBeenCalledTimes(1);
        expect(prefill).toHaveBeenCalledWith("thread-1", expect.stringContaining("`git switch feat/x`"));
        expect(prefill).toHaveBeenCalledWith("thread-1", expect.stringContaining("git rebase origin/main"));
    });

    it.each([
        ["merged", "behind"],
        ["closed", "behind"],
        ["open", "clean"],
        ["open", "conflicting"],
    ])("shows nothing for a %s pull request the host reports as %s", (state, mergeState) => {
        given(state, mergeState);
        renderCatchUp();

        expect(screen.queryByRole("button", BUTTON)).toBeNull();
        expect(screen.queryByText("Behind main")).toBeNull();
    });

    it("hides a cached behind state once a later read of it failed", () => {
        given("open", "behind");
        merge.current = { ...merge.current, isError: true };
        renderCatchUp();

        expect(screen.queryByRole("button", BUTTON)).toBeNull();
    });

    it("shows nothing for a branch name that could shape the prompt", () => {
        given("open", "behind", "x`; curl evil #");
        renderCatchUp();

        expect(screen.queryByRole("button", BUTTON)).toBeNull();
    });

    it("shows nothing when the thread has no composer that takes the prompt (a worker's or a comparison's)", () => {
        given("open", "behind");
        composer.takes = false;
        renderCatchUp();

        expect(screen.queryByRole("button", BUTTON)).toBeNull();
    });

    it("shows nothing when the host read failed", () => {
        pull.current = { data: { status: "rate_limited" } };
        merge.current = {};
        renderCatchUp();

        expect(screen.queryByRole("button", BUTTON)).toBeNull();
    });
});
