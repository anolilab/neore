/**
 * A page of files the host would not give is shown with a way to ask again: "Try again" asks for that page
 * (`retry`), not for the whole pull request, and it is offered both when no file was read and when earlier pages are on screen.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import FilesTab from "./files-tab";

const { drafts, files } = vi.hoisted(() => {
    return {
        drafts: {
            current: undefined as unknown,
        },
        files: {
            current: {} as Record<string, unknown>,
        },
    };
});

// The unit-test transform does not compile Lingui macros (vi.mock is hoisted).
vi.mock("@lingui/react/macro", () => {
    const text = (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values);

    return {
        Plural: ({ value }: { value: number }) => <>{value}</>,
        Trans: ({ children }: { children: unknown }) => <>{children as never}</>,
        useLingui: () => {
            return { i18n: { _: (descriptor: { id: string }) => descriptor.id, locale: "en" }, t: text };
        },
    };
});

vi.mock("@lingui/core/macro", () => {
    return { plural: String };
});

vi.mock("../lib/use-develop", () => {
    return { usePullRequestFiles: () => files.current };
});

const idle = { data: undefined, fetchNextPage: vi.fn(), hasNextPage: false, isError: false, isFetchingNextPage: false, isPending: false };

vi.mock("../lib/use-review", () => {
    return {
        useReviewActions: () => {
            return { setViewed: { isPending: false, mutateAsync: vi.fn(), variables: undefined } };
        },
        useDraftMutations: () => {
            return { deleteComment: { mutateAsync: vi.fn() }, saveComment: { mutateAsync: vi.fn() } };
        },
        useReviewDraft: () => {
            return { data: drafts.current };
        },
        useReviewThreads: () => idle,
        useViewedFiles: () => idle,
    };
});

vi.mock("../lib/use-review-messages", () => {
    return {
        useReviewMessages: () => {
            return { edit: String, write: String };
        },
    };
});

const retry = vi.fn(async () => undefined);

const file = { additions: 1, deletions: 0, patch: null, patchState: "host_omitted", path: "src/a.ts", previousPath: null, status: "modified" };

const renderTab = () =>
    render(
        <FilesTab
            address={{ number: 7, repository: "octo/hello" }}
            capabilities={{}}
            fileCount={3}
            fileLimit={3000}
            headSha={"a".repeat(40)}
            hostLabel="GitHub"
            leftOut={0}
            showDiff={false}
        />,
    );

describe("FilesTab: a page that failed", () => {
    beforeEach(() => {
        retry.mockClear();
    });

    it("offers Try again when no page could be read, and asks for the failed page only", () => {
        files.current = { ...idle, data: { pages: [{ status: "rate_limited" }] }, isFetching: false, retry };

        renderTab();

        expect(screen.getByRole("alert").textContent).toContain("Rate limited");

        fireEvent.click(screen.getByRole("button", { name: "Try again" }));

        expect(retry).toHaveBeenCalledTimes(1);
    });

    it("keeps the files already read on screen and offers Try again below them", () => {
        files.current = {
            ...idle,
            data: { pages: [{ files: [file], hasMore: true, page: 1, status: "ok" }, { status: "host_error" }] },
            isFetching: false,
            retry,
        };

        renderTab();

        expect(screen.getByText("src/a.ts")).toBeTruthy();

        fireEvent.click(screen.getByRole("button", { name: "Try again" }));

        expect(retry).toHaveBeenCalledTimes(1);
    });

    it("cannot be pressed again while the page is being asked for", () => {
        files.current = { ...idle, data: { pages: [{ status: "host_error" }] }, isFetching: true, retry };

        renderTab();

        expect((screen.getByRole("button", { name: "Try again" }) as HTMLButtonElement).disabled).toBe(true);
    });

    it("offers nothing when every page was read", () => {
        files.current = { ...idle, data: { pages: [{ files: [file], hasMore: false, page: 1, status: "ok" }] }, isFetching: false, retry };

        renderTab();

        expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    });
});

const RENAMED_ROW = /src\/old\.ts → src\/new\.ts/;

describe("FilesTab: pending comments with no row of their own", () => {
    const capabilities = { "review.lineComments": { available: true } };
    const comment = (id: string, path: string) => {
        return { body: `note ${id}`, id, line: 1, path, side: "new" };
    };

    beforeEach(() => {
        drafts.current = undefined;
    });

    it("lists a comment on a file the list does not show, and shows one under a renamed file's old path with its row", () => {
        files.current = {
            ...idle,
            data: { pages: [{ files: [{ ...file, path: "src/new.ts", previousPath: "src/old.ts" }], hasMore: false, page: 1, status: "ok" }] },
            isFetching: false,
            retry,
        };
        drafts.current = { comments: [comment("a", "src/old.ts"), comment("b", "src/elsewhere.ts")], submitting: false };

        render(
            <FilesTab
                address={{ number: 7, repository: "octo/hello" }}
                capabilities={capabilities as never}
                fileCount={1}
                fileLimit={3000}
                headSha={"a".repeat(40)}
                hostLabel="GitHub"
                leftOut={0}
                showDiff={false}
            />,
        );

        expect(screen.getByText("note b")).toBeTruthy();
        expect(screen.queryByText("note a")).toBeNull();

        fireEvent.click(screen.getByRole("button", { name: RENAMED_ROW }));

        expect(screen.getByText("note a")).toBeTruthy();
    });
});
