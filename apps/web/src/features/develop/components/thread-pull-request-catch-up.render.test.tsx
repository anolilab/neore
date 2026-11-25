/**
 * The Catch up control shows only for an open linked pull request whose head commit the host's comparison puts behind its base
 * branch (whatever the host's mergeability says), for the revision the pull request's read shows, and fills the thread's
 * composer without sending.
 */

import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { createRef } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { markTurnEnded, resetTurnEndedForTests } from "@/features/chat/core/utils/turn-ended";

import ThreadPullRequestCatchUp from "./thread-pull-request-catch-up";

const { compare, compareRefetch, compared, composer, prefill, pull, reads, refetch } = vi.hoisted(() => {
    return {
        compare: {
            current: {} as {
                data?: { aheadBy?: number; baseBranch?: string; behindBy?: number; headSha?: string; status: string };
                isError?: boolean;
                isFetching?: boolean;
            },
        },
        compareRefetch: vi.fn(async () => {}),
        compared: vi.fn(),
        composer: { takes: true },
        prefill: vi.fn(),
        reads: vi.fn(),
        refetch: vi.fn<() => Promise<{ data?: unknown }>>(),
        pull: {
            current: {} as {
                data?: {
                    detail?: {
                        baseBranch: string;
                        draft?: boolean;
                        headBranch: string;
                        headInBaseRepository?: boolean;
                        headSha: string;
                        mergeState?: string;
                        state: string;
                        url: string;
                    };
                    status: string;
                };
                isError?: boolean;
                isFetching?: boolean;
            },
        },
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

// The control's two host reads; a mergeability read would fail here, as `use-merge` is not reachable.
vi.mock("../lib/use-develop", () => {
    return {
        useBranchComparison: (_address: unknown, revision: unknown) => {
            compared(revision);

            return { ...compare.current, refetch: compareRefetch };
        },
        usePullRequest: () => {
            reads();

            return { ...pull.current, refetch };
        },
    };
});

vi.mock("../lib/use-merge", () => {
    return {
        useMergeStatus: () => {
            throw new Error("Catch up reads mergeability from the pull request's own read");
        },
    };
});

const BUTTON = { name: "Catch up octo/hello#7 with main" };

/** The host's comparison of the head commit with the base branch, for the revision `given` shows unless a case says otherwise. */
const comparedAs = (behindBy: number, revision: { baseBranch?: string; headSha?: string } = {}) => {
    compare.current = { data: { aheadBy: 1, baseBranch: "main", behindBy, headSha: "abc123", status: "ok", ...revision } };
};

/**
 * `head` is what the host said of the head's repository: the same as the base unless a case says otherwise. `mergeState` is the
 * host's mergeability, which Catch up does not read: "behind" there is how a repository that asks for up-to-date branches says
 * it, and the comparison is set to match unless a case sets its own.
 */
const given = (
    state: string,
    mergeState: string | undefined,
    headBranch = "feat/x",
    head?: { draft?: boolean; headInBaseRepository?: boolean; url?: string },
) => {
    comparedAs(mergeState === "behind" ? 2 : 0);
    pull.current = {
        data: {
            detail: {
                baseBranch: "main",
                headBranch,
                headSha: "abc123",
                state,
                url: "https://git.example/octo/hello/pull/7",
                ...(head ?? { headInBaseRepository: true }),
                ...(mergeState !== undefined && { mergeState }),
            },
            status: "ok",
        },
    };
};

const control = () => <ThreadPullRequestCatchUp link={{ number: 7, repository: "octo/hello" }} threadId="thread-1" />;

/** The chat's stream state saw a turn of `threadId` end (`ChatProvider`). */
const turnEnds = (threadId = "thread-1") => {
    act(() => {
        markTurnEnded(threadId);
    });
};

/** A turn of the thread ends, and the reads it starts answer (their mocks resolve at once) before this returns. */
const turnEndsAndReadsAnswer = async () => {
    await act(async () => {
        markTurnEnded("thread-1");
    });
};

/** Lets reads that already started, and whose mocks resolve at once, answer. */
const readsAnswer = async () => {
    await act(async () => {
        await Promise.resolve();
    });
};

const REBASE_ON_RUN_BASE = /`git rebase --no-update-refs refs\/worktree\/neore\/pull-7-[\da-f]{8}-base`/u;

describe("ThreadPullRequestCatchUp", () => {
    beforeEach(() => {
        resetTurnEndedForTests();
        prefill.mockReset();
        reads.mockClear();
        refetch.mockReset();
        // A read of the pull request answers with what the host says now.
        refetch.mockImplementation(async () => {
            return { data: pull.current.data };
        });
        compareRefetch.mockClear();
        compared.mockClear();
        composer.takes = true;
    });

    it("shows Behind <base> and fills the composer with the rebase prompt, without sending", () => {
        given("open", "behind");
        render(control());

        expect(screen.getByText("Behind main")).toBeTruthy();

        const button = screen.getByRole("button", BUTTON);

        expect(button.textContent).toBe("Catch up");

        fireEvent.click(button);

        expect(prefill).toHaveBeenCalledTimes(1);
        expect(prefill).toHaveBeenCalledWith("thread-1", expect.stringContaining("`git switch --no-guess feat/x && git merge --ff-only "));
        expect(prefill).toHaveBeenCalledWith("thread-1", expect.stringMatching(REBASE_ON_RUN_BASE));
        expect(prefill).toHaveBeenCalledWith("thread-1", expect.stringContaining("origin HEAD:refs/heads/feat/x`"));

        // A second click makes the very same prompt, so the composer's duplicate check adds it only once.
        fireEvent.click(button);

        expect(prefill).toHaveBeenCalledTimes(2);
        expect(prefill.mock.calls[1]).toEqual(prefill.mock.calls[0]);
    });

    it.each(["clean", "blocked", "unstable", "unknown", undefined])(
        "shows Catch up for an open pull request the host's mergeability reports as %s when the comparison puts it behind",
        (mergeState) => {
            given("open", mergeState);
            comparedAs(3);
            render(control());

            expect(screen.getByText("Behind main")).toBeTruthy();
            expect(screen.getByRole("button", BUTTON)).toBeTruthy();
            expect(compared).toHaveBeenCalledWith({ baseBranch: "main", headSha: "abc123" });
        },
    );

    it.each(["behind", "clean", "conflicting"])("shows nothing when the comparison is 0 commits behind, even when the host reports %s", (mergeState) => {
        given("open", mergeState);
        comparedAs(0);
        render(control());

        expect(screen.queryByRole("button", BUTTON)).toBeNull();
        expect(screen.queryByText("Behind main")).toBeNull();
    });

    it.each(["merged", "closed"])("shows nothing for a %s pull request and compares nothing", (state) => {
        given(state, "behind");
        render(control());

        expect(screen.queryByRole("button", BUTTON)).toBeNull();
        expect(compared).toHaveBeenLastCalledWith(undefined);
    });

    it.each([
        ["no answer yet", {}],
        ["a failed comparison", { isError: true }],
        ["a comparison the host refused", { data: { status: "not_found" } }],
        ["a comparison of another head commit", { data: { baseBranch: "main", behindBy: 2, headSha: "def456", status: "ok" } }],
        ["a comparison with another base branch", { data: { baseBranch: "develop", behindBy: 2, headSha: "abc123", status: "ok" } }],
    ])("shows nothing on %s", (_case, state) => {
        given("open", "behind");
        compare.current = state;
        render(control());

        expect(screen.queryByRole("button", BUTTON)).toBeNull();
        expect(screen.queryByText("Behind main")).toBeNull();
    });

    it("shows nothing for an open draft and compares nothing", () => {
        given("open", "behind", "feat/x", { draft: true, headInBaseRepository: true });
        render(control());

        expect(screen.queryByRole("button", BUTTON)).toBeNull();
        expect(screen.queryByText("Behind main")).toBeNull();
        expect(compared).toHaveBeenLastCalledWith(undefined);
    });

    it("hides a cached open and behind state once a read of the pull request failed", () => {
        given("open", "behind");
        pull.current = { ...pull.current, isError: true };
        render(control());

        expect(screen.queryByRole("button", BUTTON)).toBeNull();
        expect(screen.queryByText("Behind main")).toBeNull();
    });

    it("keeps the control through a background refresh", () => {
        given("open", "behind");
        pull.current = { ...pull.current, isFetching: true };
        render(control());

        expect(screen.getByRole("button", BUTTON)).toBeTruthy();
    });

    it("reads the pull request again when a turn of the thread ends while it shows, and drops the label once caught up", async () => {
        given("open", "behind");

        const view = render(control());

        expect(refetch).not.toHaveBeenCalled();

        await turnEndsAndReadsAnswer();

        expect(refetch).toHaveBeenCalledTimes(1);
        expect(compareRefetch).toHaveBeenCalledTimes(1);

        // The host's answer after the push.
        given("open", "clean");
        view.rerender(control());

        expect(screen.queryByText("Behind main")).toBeNull();
        expect(screen.queryByRole("button", BUTTON)).toBeNull();
    });

    // The header's read of the thread may not have answered when a fast turn starts and ends: no running state reaches the
    // control then, and only the chat's own end of the turn tells it.
    it("reads again for a turn that ended while the thread's read was pending, with a cached comparison that says behind", async () => {
        given("open", "behind");
        render(control());

        expect(screen.getByRole("button", BUTTON)).toBeTruthy();

        await turnEndsAndReadsAnswer();

        expect(compareRefetch).toHaveBeenCalledTimes(1);
        expect(refetch).toHaveBeenCalledTimes(1);
    });

    // A first read that started before an agent pushed may answer with the earlier state after the turn ended.
    it("reads again after a first read that was pending when a turn ended, and shows nothing until that read answers", async () => {
        pull.current = { isFetching: true };
        compare.current = {};

        const view = render(control());

        turnEnds();

        expect(refetch).not.toHaveBeenCalled();

        // The pending read answers with the state from before the turn: behind.
        given("open", "behind");

        let answer: (value: { data?: unknown }) => void = () => {};

        // The tsconfig lib predates `Promise.withResolvers`.
        // eslint-disable-next-line unicorn/prefer-promise-with-resolvers
        const promise = new Promise<{ data?: unknown }>((resolve: (value: { data?: unknown }) => void) => {
            answer = resolve;
        });

        refetch.mockImplementationOnce(async () => promise);
        view.rerender(control());

        expect(refetch).toHaveBeenCalledTimes(1);
        expect(screen.queryByRole("button", BUTTON)).toBeNull();

        // The read after the turn: the agent caught the branch up.
        given("open", "clean");
        await act(async () => {
            answer({ data: pull.current.data });
        });

        expect(compareRefetch).toHaveBeenCalledTimes(1);
        expect(screen.queryByRole("button", BUTTON)).toBeNull();
        expect(refetch).toHaveBeenCalledTimes(1);
    });

    it("reads again after a first comparison that was pending when a turn ended, then shows the host's answer", async () => {
        given("open", "behind");
        compare.current = { isFetching: true };

        const view = render(control());

        turnEnds();

        expect(refetch).not.toHaveBeenCalled();

        // The pending comparison answers behind, from before the turn.
        comparedAs(2);
        view.rerender(control());

        expect(screen.queryByRole("button", BUTTON)).toBeNull();

        await readsAnswer();

        expect(compareRefetch).toHaveBeenCalledTimes(1);
        expect(refetch).toHaveBeenCalledTimes(1);
        // Still behind after the turn: the control shows.
        expect(screen.getByRole("button", BUTTON)).toBeTruthy();
    });

    it("drops the read a turn's end owed when the pending first read answers with a pull request that cannot show", () => {
        pull.current = { isFetching: true };
        compare.current = {};

        const view = render(control());

        turnEnds();
        given("open", "behind", "feat/x", { draft: true, headInBaseRepository: true });
        view.rerender(control());

        expect(refetch).not.toHaveBeenCalled();
        expect(compareRefetch).not.toHaveBeenCalled();
    });

    it("reads nothing again for another thread's turn, nor after it unmounts", () => {
        given("open", "behind");

        const view = render(control());

        turnEnds("thread-2");
        view.unmount();
        turnEnds();

        expect(refetch).not.toHaveBeenCalled();
        expect(compareRefetch).not.toHaveBeenCalled();
    });

    // A new head gives the comparison a new key, which reads by itself; a closed pull request or a draft hides the control,
    // which reads nothing.
    it.each([
        ["pushed a new head", { headSha: "def456" }],
        ["closed the pull request", { state: "closed" }],
        ["made the pull request a draft", { draft: true }],
    ])("leaves the comparison unread when the turn %s", async (_case, change) => {
        given("open", "behind");
        render(control());

        // The pull request's read after the turn answers with the change.
        refetch.mockImplementationOnce(async () => {
            return { data: { detail: { ...pull.current.data!.detail!, ...change }, status: "ok" } };
        });
        await turnEndsAndReadsAnswer();

        expect(refetch).toHaveBeenCalledTimes(1);
        expect(compareRefetch).not.toHaveBeenCalled();
    });

    it("hides the control when a turn ends during a background refresh, and reads again once that refresh settles", async () => {
        given("open", "behind");
        pull.current = { ...pull.current, isFetching: true };

        const view = render(control());

        expect(screen.getByRole("button", BUTTON)).toBeTruthy();

        turnEnds();

        // The refresh started before the turn ended: its "behind" may be from before the turn.
        expect(refetch).not.toHaveBeenCalled();
        expect(screen.queryByRole("button", BUTTON)).toBeNull();

        // The refresh answers, still behind; then the read the turn's end owed answers too.
        given("open", "behind");
        view.rerender(control());
        await readsAnswer();

        expect(refetch).toHaveBeenCalledTimes(1);
        expect(compareRefetch).toHaveBeenCalledTimes(1);
        expect(screen.getByRole("button", BUTTON)).toBeTruthy();
    });

    it.each([
        [
            "a failed comparison",
            () => {
                compare.current = { isError: true };
            },
        ],
        [
            "a failed pull request read",
            () => {
                pull.current = { ...pull.current, isError: true };
            },
        ],
        [
            "a pull request read the host refused",
            () => {
                pull.current = { data: { status: "rate_limited" } };
            },
        ],
    ])("hides the control on %s at a turn's end, reads again at the next one, and shows it once the host says behind", async (_case, fail) => {
        given("open", "behind");

        const view = render(control());

        await turnEndsAndReadsAnswer();

        expect(compareRefetch).toHaveBeenCalledTimes(1);

        // The turn-end read failed.
        fail();
        view.rerender(control());

        expect(screen.queryByRole("button", BUTTON)).toBeNull();
        expect(screen.queryByText("Behind main")).toBeNull();

        turnEnds();

        expect(refetch).toHaveBeenCalledTimes(2);

        // The host answers again: still behind.
        given("open", "behind");
        view.rerender(control());

        expect(screen.getByRole("button", BUTTON)).toBeTruthy();
    });

    it.each([
        [
            "caught up",
            () => {
                comparedAs(0);
            },
        ],
        [
            "closed",
            () => {
                given("closed", "behind");
            },
        ],
        [
            "merged",
            () => {
                given("merged", "behind");
            },
        ],
        [
            "a draft",
            () => {
                given("open", "behind", "feat/x", { draft: true, headInBaseRepository: true });
            },
        ],
    ])("stops reading at a turn's end once a read confirms the pull request %s", (_case, settle) => {
        given("open", "behind");

        const view = render(control());

        settle();
        view.rerender(control());
        turnEnds();

        expect(refetch).not.toHaveBeenCalled();
        expect(compareRefetch).not.toHaveBeenCalled();

        // A failed read after that does not bring the reads back.
        compare.current = { isError: true };
        view.rerender(control());
        turnEnds();

        expect(refetch).not.toHaveBeenCalled();
    });

    it("reads again once on a remount after a turn ended while it was not mounted, and shows no cached Behind meanwhile", async () => {
        // Its own thread: what a control heard is kept per thread and pull request across mounts.
        const missed = () => <ThreadPullRequestCatchUp link={{ number: 7, repository: "octo/hello" }} threadId="thread-missed" />;

        given("open", "behind");

        const view = render(missed());

        expect(screen.getByText("Behind main")).toBeTruthy();

        // The pane loses focus: its composer, and with it the control, goes away; the chat goes on and the turn ends.
        composer.takes = false;
        view.rerender(missed());
        turnEnds("thread-missed");

        expect(refetch).not.toHaveBeenCalled();

        // The turn pushed; the host has not answered the read yet.
        let answer: (value: { data?: unknown }) => void = () => {};

        refetch.mockImplementationOnce(
            async () =>
                // The tsconfig lib predates `Promise.withResolvers`.
                // eslint-disable-next-line unicorn/prefer-promise-with-resolvers
                await new Promise<{ data?: unknown }>((resolve) => {
                    answer = resolve;
                }),
        );
        composer.takes = true;
        view.rerender(missed());

        expect(refetch).toHaveBeenCalledTimes(1);
        // The cached comparison still says behind, but it predates the turn.
        expect(screen.queryByText("Behind main")).toBeNull();
        expect(screen.queryByRole("button", BUTTON)).toBeNull();

        await act(async () => {
            answer({ data: pull.current.data });
            await Promise.resolve();
        });

        // Same revision: the base branch may have moved, so the comparison is read too, and the host still says behind.
        expect(compareRefetch).toHaveBeenCalledTimes(1);
        expect(refetch).toHaveBeenCalledTimes(1);
        expect(screen.getByText("Behind main")).toBeTruthy();
    });

    it("reads nothing extra on a remount when no turn ended while it was not mounted", () => {
        const quiet = () => <ThreadPullRequestCatchUp link={{ number: 7, repository: "octo/hello" }} threadId="thread-quiet" />;

        given("open", "behind");

        const view = render(quiet());

        composer.takes = false;
        view.rerender(quiet());
        composer.takes = true;
        view.rerender(quiet());

        expect(screen.getByText("Behind main")).toBeTruthy();
        expect(refetch).not.toHaveBeenCalled();
        expect(compareRefetch).not.toHaveBeenCalled();
    });

    it("makes no extra read at the end of a turn while it does not show", () => {
        given("open", "clean");
        render(control());

        turnEnds();

        expect(refetch).not.toHaveBeenCalled();
        expect(compareRefetch).not.toHaveBeenCalled();
    });

    it("shows nothing for a branch name that could shape the prompt", () => {
        given("open", "behind", "x`; curl evil #");
        render(control());

        expect(screen.queryByRole("button", BUTTON)).toBeNull();
    });

    it.each([
        ["a branch name that could shape the prompt", "x`; curl evil #", "https://git.example/octo/hello/pull/7"],
        ["a pull request address on no plain host", "feat/x", "https://[::1]/octo/hello/pull/7"],
    ])("reads nothing again at a turn's end, nor on a remount after a missed turn, for %s", (_case, headBranch, url) => {
        const hidden = () => <ThreadPullRequestCatchUp link={{ number: 7, repository: "octo/hello" }} threadId="thread-hidden" />;

        given("open", "behind", headBranch, { headInBaseRepository: true, url });

        const view = render(hidden());

        expect(screen.queryByRole("button", BUTTON)).toBeNull();

        turnEnds("thread-hidden");

        composer.takes = false;
        view.rerender(hidden());
        turnEnds("thread-hidden");
        composer.takes = true;
        view.rerender(hidden());

        expect(refetch).not.toHaveBeenCalled();
        expect(compareRefetch).not.toHaveBeenCalled();
        expect(screen.queryByRole("button", BUTTON)).toBeNull();
    });

    it.each([
        ["the host reports a fork", { headInBaseRepository: false }],
        ["the host's answer predates the head repository", {}],
    ])("fills a prompt that pushes nothing when %s", (_case, head) => {
        given("open", "behind", "feat/x", head);
        render(control());
        fireEvent.click(screen.getByRole("button", BUTTON));

        expect(prefill).toHaveBeenCalledWith("thread-1", expect.stringContaining("comes from a fork"));
        expect(prefill).toHaveBeenCalledWith("thread-1", expect.not.stringContaining("git push"));
    });

    it("reads nothing from the host when the thread has no composer that takes the prompt (a worker's or a comparison's)", () => {
        given("open", "behind");
        composer.takes = false;
        render(control());

        expect(screen.queryByRole("button", BUTTON)).toBeNull();
        expect(reads).not.toHaveBeenCalled();
    });

    it("shows nothing when the host read failed", () => {
        pull.current = { data: { status: "rate_limited" } };
        render(control());

        expect(screen.queryByRole("button", BUTTON)).toBeNull();
    });
    it("moves focus to the pull request's link when a read removes the focused control, and leaves other focus alone", () => {
        const returnFocusTo = createRef<HTMLAnchorElement>();
        const view = () => (
            <>
                <a href="#pr" ref={returnFocusTo}>
                    octo/hello#7
                </a>
                <input aria-label="elsewhere" />
                <ThreadPullRequestCatchUp link={{ number: 7, repository: "octo/hello" }} returnFocusTo={returnFocusTo} threadId="thread-1" />
            </>
        );

        given("open", "behind");

        const { rerender } = render(view());

        screen.getByRole("button", BUTTON).focus();
        comparedAs(0);
        rerender(view());

        // eslint-disable-next-line testing-library/no-node-access -- where focus lands is what this asserts
        expect(document.activeElement).toBe(screen.getByRole("link", { name: "octo/hello#7" }));

        given("open", "behind");
        rerender(view());
        screen.getByRole("textbox", { name: "elsewhere" }).focus();
        pull.current = { ...pull.current, isError: true };
        rerender(view());

        // eslint-disable-next-line testing-library/no-node-access -- where focus lands is what this asserts
        expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "elsewhere" }));
    });
});
