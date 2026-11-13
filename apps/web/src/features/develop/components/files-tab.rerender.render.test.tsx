/**
 * A review change on one file draws that file's row again, not every open diff in the list: marking a file viewed, or
 * a new pending comment on it, leaves the other rows' diffs alone. Each open diff's renders are counted by path.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import FilesTab from "./files-tab";

const { diffRenders, review } = vi.hoisted(() => {
    // The hooks hand back the same objects between renders, as TanStack Query and the compiled hooks do.
    const pending: { resolve?: (value: { status: string }) => void } = {};
    const mutateAsync = async () =>
        await new Promise<{ status: string }>((resolve) => {
            pending.resolve = resolve;
        });

    return {
        diffRenders: new Map<string, number>(),
        review: {
            actions: { setViewed: { isPending: false, mutateAsync, variables: undefined } },
            draft: { data: undefined as unknown },
            files: { current: {} as Record<string, unknown> },
            messages: { edit: String, write: String },
            pending,
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
            return { t: text };
        },
    };
});

vi.mock("@lingui/core/macro", () => {
    return { plural: String };
});

vi.mock("../lib/use-develop", () => {
    return { usePullRequestFiles: () => review.files.current };
});

const idle = { data: undefined, fetchNextPage: vi.fn(), hasNextPage: false, isError: false, isFetchingNextPage: false, isPending: false };

vi.mock("../lib/use-review", () => {
    return {
        useReviewActions: () => review.actions,
        useReviewDraft: () => review.draft,
        useReviewThreads: () => idle,
        useViewedFiles: () => idle,
    };
});

vi.mock("../lib/use-review-messages", () => {
    return { useReviewMessages: () => review.messages };
});

// Stand-in for the open diff: counts how often each file's diff is drawn.
vi.mock("./review-diff", () => {
    return {
        default: ({ draftComments, path }: { draftComments: unknown[]; path: string }) => {
            diffRenders.set(path, (diffRenders.get(path) ?? 0) + 1);

            return <p>{`diff of ${path}, ${String(draftComments.length)} pending`}</p>;
        },
        DraftComment: () => null,
    };
});

const PATHS = ["src/a.ts", "src/b.ts", "src/c.ts"];
const ROW_NAMES = [/src\/a\.ts/u, /src\/b\.ts/u, /src\/c\.ts/u];
const FILES = PATHS.map((path) => {
    return { additions: 1, deletions: 0, patch: "@@ -1 +1 @@\n-a\n+b", patchState: "full", path, previousPath: null, status: "modified" };
});
const SUPPORTED = { degradation: "none", supported: true } as const;
const CAPABILITIES = { groups: { review: { lineComments: SUPPORTED, viewedMarks: SUPPORTED } } };
const ADDRESS = { number: 7, repository: "octo/hello" };

const comment = (id: string, path: string) => {
    return { body: `note ${id}`, id, line: 1, path, side: "new" };
};

const tab = () => (
    <FilesTab address={ADDRESS} capabilities={CAPABILITIES} fileCount={3} fileLimit={3000} headSha={"a".repeat(40)} hostLabel="GitHub" leftOut={0} showDiff />
);

/** Renders the tab with every file open, then starts counting from zero. */
const renderOpen = () => {
    const view = render(tab());

    for (const name of ROW_NAMES) {
        fireEvent.click(screen.getByRole("button", { name }));
    }

    expect(screen.getByText("diff of src/c.ts, 0 pending")).toBeTruthy();
    diffRenders.clear();

    return view;
};

describe("FilesTab: re-renders", () => {
    beforeEach(() => {
        diffRenders.clear();
        review.files.current = { ...idle, data: { pages: [{ files: FILES, hasMore: false, page: 1, status: "ok" }] }, isFetching: false, retry: vi.fn() };
        review.draft = { data: { comments: [comment("b1", "src/b.ts")], submitting: false } };
    });

    it("marking one file viewed draws that file's diff only", async () => {
        renderOpen();

        const [firstCheckbox] = screen.getAllByRole("checkbox");

        fireEvent.click(firstCheckbox!);

        // Its checkbox is disabled while the call runs: that row was drawn again, the others were not.
        expect(diffRenders.get("src/a.ts")).toBe(1);
        expect(diffRenders.has("src/b.ts")).toBe(false);
        expect(diffRenders.has("src/c.ts")).toBe(false);

        await act(async () => {
            review.pending.resolve?.({ status: "ok" });
        });

        expect(diffRenders.has("src/b.ts")).toBe(false);
        expect(diffRenders.has("src/c.ts")).toBe(false);
    });

    it("a new pending comment on one file draws that file's diff only", () => {
        const view = renderOpen();
        const kept = (review.draft.data as { comments: unknown[] }).comments[0];

        review.draft = { data: { comments: [kept, comment("a1", "src/a.ts")], submitting: false } };
        view.rerender(tab());

        expect(screen.getByText("diff of src/a.ts, 1 pending")).toBeTruthy();
        expect(diffRenders.get("src/a.ts")).toBe(1);
        // src/b.ts kept the same comment, regrouped into a new list: its row is not drawn again.
        expect(diffRenders.has("src/b.ts")).toBe(false);
        expect(diffRenders.has("src/c.ts")).toBe(false);
    });
});
