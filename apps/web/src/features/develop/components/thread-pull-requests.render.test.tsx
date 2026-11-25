/* eslint-disable testing-library/no-node-access -- focus placement (document.activeElement) is what these tests assert */

/**
 * The linked pull requests keep keyboard focus on the page when a re-render removes the focused control: a row that drops out
 * of the newest few unmounts its Catch up and fixes controls at once, and an unlinked row goes away whole.
 */

import { render, screen } from "@testing-library/react";
import type { ReactNode, Ref } from "react";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";

import { LinkedPullRequestList } from "./thread-pull-requests";

// The unit-test transform does not compile Lingui macros (vi.mock is hoisted).
vi.mock("@lingui/react/macro", () => {
    const text = (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values);

    return {
        Plural: () => null,
        useLingui: () => {
            return { t: text };
        },
    };
});

vi.mock("@tanstack/react-router", () => {
    return {
        Link: ({ children, ref, search: _search, to, ...props }: { children: ReactNode; ref?: Ref<HTMLAnchorElement>; search?: unknown; to: string }) => (
            <a href={to} ref={ref} {...props}>
                {children}
            </a>
        ),
    };
});

// Stand-ins with no host reads: a shown Catch up button, and no fixes.
vi.mock("./thread-pull-request-catch-up", () => {
    return {
        default: ({ link }: { link: { number: number; repository: string } }) => (
            <button type="button">{`Catch up ${link.repository}#${String(link.number)}`}</button>
        ),
    };
});

vi.mock("./pull-request-fixes", () => {
    return { default: () => null };
});

const linksOf = (...numbers: number[]) =>
    numbers.map((number) => {
        return { number, repository: "octo/hello" };
    });

const list = (numbers: number[], fallback = createRef<HTMLButtonElement>()) => (
    <>
        <LinkedPullRequestList fallbackFocus={fallback} links={linksOf(...numbers)} threadId="thread-1" />
        <button ref={fallback} type="button">
            Link pull request
        </button>
    </>
);

const focusOn = (element: HTMLElement) => {
    element.focus();
};

describe("linked pull requests' focus", () => {
    it("keeps a focused Catch up button where it is when a new link is added, since the view reads that link too", () => {
        const view = render(list([5, 4, 3, 2, 1]));

        focusOn(screen.getByRole("button", { name: "Catch up octo/hello#1" }));
        view.rerender(list([6, 5, 4, 3, 2, 1]));

        expect(screen.getByRole("button", { name: "Catch up octo/hello#1" })).toBeTruthy();
        expect(document.activeElement).toBe(screen.getByRole("button", { name: "Catch up octo/hello#1" }));
    });

    it("moves focus to the next row's link when the focused row is unlinked, else the one before, else the link button", () => {
        const view = render(list([3, 2, 1]));

        focusOn(screen.getByRole("button", { name: "Catch up octo/hello#2" }));
        view.rerender(list([3, 1]));

        expect(document.activeElement).toBe(screen.getByRole("link", { name: "Open the pull request octo/hello#1" }));

        view.rerender(list([3]));

        expect(document.activeElement).toBe(screen.getByRole("link", { name: "Open the pull request octo/hello#3" }));

        view.rerender(list([]));

        expect(document.activeElement).toBe(screen.getByRole("button", { name: "Link pull request" }));
    });

    it("leaves focus that is elsewhere where it is", () => {
        const view = render(list([5, 4, 3, 2, 1]));
        const elsewhere = screen.getByRole("button", { name: "Link pull request" });

        focusOn(screen.getByRole("button", { name: "Catch up octo/hello#1" }));
        focusOn(elsewhere);
        view.rerender(list([6, 5, 4, 3, 2, 1]));

        expect(document.activeElement).toBe(elsewhere);
    });
});
