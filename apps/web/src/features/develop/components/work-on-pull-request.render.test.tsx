/** A thread list that is still loading or failed is not "no thread has worked on this yet". */

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import WorkOnPullRequest from "./work-on-pull-request";

const { threads } = vi.hoisted(() => {
    return { threads: { current: {} as { data?: unknown[]; isError?: boolean; isPending?: boolean } } };
});

vi.mock("@lingui/react/macro", () => {
    const text = (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values);

    return {
        useLingui: () => {
            return { t: text };
        },
    };
});

vi.mock("@tanstack/react-router", () => {
    return {
        Link: ({ children }: { children: unknown }) => <a href="/x">{children as never}</a>,
        useNavigate: () => vi.fn(),
    };
});

vi.mock("../lib/use-develop", () => {
    return {
        usePullRequestThreads: () => threads.current,
        useStartWorkOnPullRequest: () => {
            return { isPending: false, mutateAsync: vi.fn() };
        },
    };
});

const NONE = /No thread has worked/u;
const address = { number: 1, repository: "o/r" } as never;

describe("WorkOnPullRequest thread list", () => {
    beforeEach(() => {
        threads.current = {};
    });

    it("says it is loading, not that nothing worked on it", () => {
        threads.current = { isPending: true };
        render(<WorkOnPullRequest address={address} requestNoun="pull request" />);

        expect(screen.getByText("Loading threads…")).toBeTruthy();
        expect(screen.queryByText(NONE)).toBeNull();
    });

    it("says it failed to load", () => {
        threads.current = { isError: true };
        render(<WorkOnPullRequest address={address} requestNoun="pull request" />);

        expect(screen.getByRole("alert").textContent).toContain("Could not load the threads");
        expect(screen.queryByText(NONE)).toBeNull();
    });

    it("says nothing worked on it only when the list is empty", () => {
        threads.current = { data: [], isError: false, isPending: false };
        render(<WorkOnPullRequest address={address} requestNoun="pull request" />);

        expect(screen.getByText(NONE)).toBeTruthy();
    });
});
