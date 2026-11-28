import type { ReturnOf } from "@lunora/react";
import { api } from "@neore/backend/api";

import { ago, DAY, HOUR, MINUTE } from "../clock";
import type { LunoraFixture } from "../lunora";
import { lunora } from "../lunora";
import { developFixtures } from "./workspace";

const supported = { degradation: "none", supported: true } as const;

/** A Git host that offers every read and write the pull request view has a place for. */
const HOST = {
    capabilities: {
        groups: {
            checks: { requiredState: supported, rerun: supported },
            freshness: { conditionalPolling: supported, webhooks: supported },
            inbox: { drafts: supported, mine: supported, needsMyReview: supported, readyToMerge: supported },
            merge: { auto: supported, now: supported },
            pullRequest: {
                checks: supported,
                commits: supported,
                description: supported,
                diff: supported,
                edit: supported,
                files: supported,
                guide: supported,
            },
            review: {
                batchedSubmit: supported,
                lineComments: supported,
                replies: supported,
                resolveThreads: supported,
                verdictApprove: supported,
                verdictComment: supported,
                verdictRequestChanges: supported,
                viewedMarks: supported,
            },
            reviewers: { request: supported },
        },
        reportedAt: ago(HOUR),
        version: 1,
    },
    connectorSlug: "github",
    label: "GitHub",
    limits: { commits: 250, files: 300, reviewers: 15 },
    requestNoun: "pull request",
} as const;

export const HEAD_SHA = "9f2c1d7e4b6a8c0d1e2f3a4b5c6d7e8f9a0b1c2d";

type Files = Extract<ReturnOf<typeof api.source_control.functions.getPullRequestFiles>, { status: "ok" }>["files"];
type Threads = Extract<ReturnOf<typeof api.source_control.review_functions.getReviewThreads>, { status: "ok" }>["threads"];
type Checks = Extract<ReturnOf<typeof api.source_control.functions.getPullRequestChecks>, { status: "ok" }>;
type Commits = Extract<ReturnOf<typeof api.source_control.functions.getPullRequestCommits>, { status: "ok" }>["commits"];
type Viewed = Extract<ReturnOf<typeof api.source_control.review_functions.getViewedFiles>, { status: "ok" }>;
type Merge = Extract<ReturnOf<typeof api.source_control.merge_functions.getMergeStatus>, { status: "ok" }>;
type Guide = NonNullable<ReturnOf<typeof api.source_control.guide_functions.getGuide>>;
type Draft = NonNullable<ReturnOf<typeof api.source_control.review_drafts.getReviewDraft>>;

const TITLES_PATCH = [
    '@@ -10,11 +10,21 @@ import { ago } from "./time";',
    ' import { fetchTitle } from "./api";',
    " ",
    " const cache = new Map<string, string>();",
    " ",
    "-export const titleFor = (id: string) => {",
    "-    return fetchTitle(id);",
    "-};",
    "+export const titleFor = (owner: string, id: string) => {",
    "+    const key = `${owner}:${id}`;",
    "+    const hit = cache.get(key);",
    "+",
    "+    if (hit !== undefined) {",
    "+        return hit;",
    "+    }",
    "+",
    "+    const title = fetchTitle(id);",
    "+    cache.set(key, title);",
    "+",
    "+    return title;",
    "+};",
    " ",
    " export const clearTitles = () => {",
    "     cache.clear();",
    " };",
].join("\n");

const LIST_PATCH = [
    "@@ -3,7 +3,7 @@ export const useThreadList = (owner: string) => {",
    "     const threads = useThreads(owner);",
    " ",
    "     return threads.map((thread) => {",
    "-        return { ...thread, title: titleFor(thread.id) };",
    "+        return { ...thread, title: titleFor(owner, thread.id) };",
    "     });",
    " };",
].join("\n");

export const FILES: Files = [
    { additions: 12, deletions: 3, patch: TITLES_PATCH, patchState: "full", path: "src/lib/thread-titles.ts", previousPath: null, status: "modified" },
    { additions: 1, deletions: 1, patch: LIST_PATCH, patchState: "full", path: "src/hooks/use-thread-list.ts", previousPath: null, status: "modified" },
    {
        additions: 0,
        deletions: 0,
        patch: null,
        patchState: "host_omitted",
        path: "src/components/sidebar/thread-row.tsx",
        previousPath: "src/components/sidebar/thread-item.tsx",
        status: "renamed",
    },
    {
        additions: 74,
        deletions: 0,
        patch: ["@@ -0,0 +1,3 @@", '+import { expect, it } from "vitest";', "+", '+it("shares a title between rows of one owner", () => {});'].join("\n"),
        patchState: "full",
        path: "src/lib/thread-titles.test.ts",
        previousPath: null,
        status: "added",
    },
    { additions: 0, deletions: 0, patch: null, patchState: "host_omitted", path: "public/sidebar-empty.png", previousPath: null, status: "added" },
];

export const THREADS: Threads = [
    {
        canResolve: true,
        canUnresolve: true,
        comments: [
            {
                authorLogin: "grace",
                body: "Does this need an eviction? A long session keeps every title it ever read.",
                createdAt: ago(5 * HOUR),
                id: "comment_1",
                url: "https://github.com/acme/storefront/pull/482#discussion_r1",
            },
            {
                authorLogin: "ada",
                body: "Good catch. The map is cleared on sign-out, but I will cap it at 500 entries too.",
                createdAt: ago(4 * HOUR),
                id: "comment_2",
            },
        ],
        id: "thread_1",
        isOutdated: false,
        isResolved: false,
        line: 22,
        path: "src/lib/thread-titles.ts",
        side: "new",
        startLine: null,
    },
    {
        canResolve: true,
        canUnresolve: true,
        comments: [{ authorLogin: "linus", body: "Nit: name this `ownerId`, the rest of the file does.", createdAt: ago(DAY), id: "comment_3" }],
        id: "thread_2",
        isOutdated: true,
        isResolved: true,
        line: 14,
        path: "src/lib/thread-titles.ts",
        side: "new",
        startLine: null,
    },
];

export const DRAFT: Draft = {
    body: "",
    comments: [
        {
            body: "Add a test where two owners share a thread id.",
            createdAt: ago(10 * MINUTE),
            id: "draft_1",
            line: 25,
            path: "src/lib/thread-titles.ts",
            side: "new",
            startLine: null,
        },
    ],
    commitId: HEAD_SHA,
    revision: 3,
    submitting: false,
    updatedAt: ago(10 * MINUTE),
    verdict: null,
};

export const CHECKS: Checks = {
    checks: [
        { id: "check_1", name: "lint", required: true, state: "success", url: "https://github.com/acme/storefront/actions/runs/1" },
        { id: "check_2", name: "unit tests (ubuntu)", required: true, state: "failure", url: "https://github.com/acme/storefront/actions/runs/2" },
        { id: "check_3", name: "unit tests (windows)", required: true, state: "pending", url: null },
        { id: "check_4", name: "e2e smoke", required: false, state: "failure", url: "https://github.com/acme/storefront/actions/runs/4" },
        { id: "check_5", name: "bundle size", required: false, state: "success", url: null },
        { id: null, name: "deploy preview", required: false, state: "skipped", url: null },
    ],
    rollup: { complete: true, failing: 1, optionalFailing: 1, pending: 1, state: "failing", waiting: [] },
    status: "ok",
    total: 6,
};

export const CHECKS_EMPTY: Checks = {
    checks: [],
    rollup: { complete: true, failing: 0, optionalFailing: 0, pending: 0, state: "none", waiting: [] },
    status: "ok",
    total: 0,
};

export const COMMITS: Commits = [
    {
        authorName: "Ada Lovelace",
        committedAt: ago(DAY),
        message: "Read thread titles once per owner\n\nThe sidebar asked for each title on its own.",
        sha: "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b",
    },
    {
        authorName: "Ada Lovelace",
        committedAt: ago(20 * HOUR),
        message: "Drop the duplicate query in the header",
        sha: "2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c",
    },
    { authorName: "Ada Lovelace", committedAt: ago(2 * HOUR), message: "Cap the title cache at 500 entries", sha: HEAD_SHA },
];

const VIEWED: Viewed = { endCursor: null, files: [{ path: "src/hooks/use-thread-list.ts", state: "viewed" }], hasMore: false, status: "ok" };

export const MERGE_CLEAN: Merge = { autoMergeAllowed: true, autoMergeEnabled: false, methods: ["squash", "merge", "rebase"], state: "clean", status: "ok" };

export const MERGE_BLOCKED: Merge = { autoMergeAllowed: true, autoMergeEnabled: true, methods: ["squash"], state: "blocked", status: "ok" };

export const GUIDE: Guide = {
    freshness: "current",
    guide: {
        generatedAt: ago(HOUR),
        headSha: HEAD_SHA,
        id: "guide_1",
        instructions: "Look hard at the cache keys.",
        leftOut: 0,
        proposals: [
            {
                body: "A title for a signed-out owner would be cached under `undefined:`. Guard the key.",
                id: "proposal_1",
                kind: "comment",
                line: 15,
                path: "src/lib/thread-titles.ts",
                side: "new",
                startLine: null,
                status: "proposed",
            },
            { id: "proposal_2", kind: "label", name: "performance", reason: "The change removes a per-row read.", status: "proposed" },
        ],
        source: "cloud",
        status: "ready",
        stops: [
            {
                explanation: "The cache and its key: one title is read once per owner and id.",
                files: [{ path: "src/lib/thread-titles.ts", ranges: [{ end: 26, side: "new", start: 14 }] }],
                id: "stop_1",
                kind: "core",
                title: "Per-owner title cache",
            },
            {
                explanation: "The only caller passes the owner now.",
                files: [{ path: "src/hooks/use-thread-list.ts", ranges: [{ end: 6, side: "new", start: 6 }] }],
                id: "stop_2",
                kind: "dependent",
                title: "Callers",
            },
            {
                explanation: "",
                files: [{ path: "src/components/sidebar/thread-row.tsx", ranges: [] }],
                id: "stop_3",
                kind: "mechanical",
                title: "",
            },
        ],
        summary: "Thread titles are cached per owner, so the sidebar reads each title once instead of once per row.",
    },
};

export interface DevelopReviewOptions {
    checks?: Checks;
    commits?: Commits;
    draft?: Draft | null;
    files?: Files;
    guide?: Guide | null;
    merge?: Merge;
    threads?: Threads;
}

/**
 * Everything the selected pull request's tabs read, on a host that offers the whole review: the Develop page's own
 * fixtures first, then the files, review threads, checks, commits, merge status and guide on top of them.
 */
export const developReviewFixtures = (options: DevelopReviewOptions = {}): LunoraFixture[] => {
    return [
        ...developFixtures(),
        lunora(api.source_control.functions.getDevelopHost, { connected: true, host: HOST } as never),
        lunora(api.source_control.functions.getPullRequestFiles, { files: options.files ?? FILES, hasMore: false, page: 1, status: "ok" }),
        lunora(api.source_control.functions.getPullRequestCommits, { commits: options.commits ?? COMMITS, hasMore: false, page: 1, status: "ok" }),
        lunora(api.source_control.functions.getPullRequestChecks, options.checks ?? CHECKS),
        lunora(api.source_control.review_functions.getReviewThreads, { endCursor: null, hasMore: false, status: "ok", threads: options.threads ?? THREADS }),
        lunora(api.source_control.review_functions.getViewedFiles, VIEWED),
        lunora(api.source_control.review_drafts.getReviewDraft, options.draft === undefined ? null : options.draft),
        lunora(api.source_control.merge_functions.getMergeStatus, options.merge ?? MERGE_CLEAN),
        lunora(api.source_control.guide_functions.getGuide, options.guide === undefined ? GUIDE : options.guide),
        lunora(api.devices.functions.listDevices, []),
        lunora(api.source_control.freshness.listWatchedRepositories, { limit: 20, watched: [] }),
        lunora(api.source_control.freshness.refreshWatchedRepositories, { polled: 0, status: "ok" }),
    ];
};
