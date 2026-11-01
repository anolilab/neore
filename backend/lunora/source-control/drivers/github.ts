/**
 * The GitHub driver: reads only. Every call goes through the `HostRequest` the
 * caller bound to `https://api.github.com`, so the token reaches nowhere else.
 *
 * Limits, from GitHub's REST documentation: a pull request lists at most 3000
 * files and 250 commits, 100 to a page; search answers at most 1000 results.
 */
import z from "zod/v4";

import type { HostCapabilityReport } from "../capabilities";
import { requirementOf } from "../checks-logic";
import type { CreatePullRequestInput, CreatedPullRequest, HostDriver } from "../driver";
import { graphqlRequest } from "../graphql";
import { HostApiError } from "../origin-fetch";
import type { HostRequest } from "../origin-fetch";
import { discard, parse, readJson } from "../response";
import type {
    CheckRun,
    CheckState,
    CheckSummary,
    CommitPage,
    CursorPage,
    DiffSide,
    FilePage,
    FileStatus,
    InboxPage,
    InboxSection,
    MergedPullRequest,
    MergeMethod,
    MergeRequest,
    MergeState,
    MergeStatus,
    PullRequestDetail,
    PullRequestFile,
    PullRequestRef,
    PullRequestSummary,
    RepoPoll,
    RequiredChecks,
    ReviewSubmission,
    ReviewThread,
    SubmittedReview,
    ThreadComment,
    ViewedFile,
    ViewedState,
} from "../types";

export const GITHUB_API_ORIGIN = "https://api.github.com";
export const GITHUB_WEB_ORIGIN = "https://github.com";

/** Files GitHub lists for one pull request, whatever its size. */
export const GITHUB_FILE_LIMIT = 3000;
/** Commits GitHub lists for one pull request. */
export const GITHUB_COMMIT_LIMIT = 250;
export const GITHUB_PAGE_SIZE = 100;
/** A poll reads page one of a repository's open pull requests, newest activity first. */
export const GITHUB_POLL_PAGE_SIZE = 100;
const INBOX_PAGE_SIZE = 30;

const SEARCH_RESULT_LIMIT = 1000;

/** GitHub search stops at 1000 results: the last page of 30 holds the final 10. */
export const GITHUB_INBOX_MAX_PAGE = Math.ceil(SEARCH_RESULT_LIMIT / INBOX_PAGE_SIZE);

const MAX_FILE_PAGE = Math.ceil(GITHUB_FILE_LIMIT / GITHUB_PAGE_SIZE);
const MAX_COMMIT_PAGE = Math.ceil(GITHUB_COMMIT_LIMIT / GITHUB_PAGE_SIZE);

/** Longest patch kept for one file, and for all the files of one page. */
export const PATCH_MAX_CHARS = 60_000;
export const PAGE_PATCH_BUDGET_CHARS = 600_000;
const BODY_MAX_CHARS = 60_000;

const NATIVE = { degradation: "none", supported: true } as const;

export const GITHUB_CAPABILITIES: HostCapabilityReport = {
    groups: {
        checks: {
            // Rulesets are readable by anyone; legacy branch protection only with admin rights, else every failing check counts.
            requiredState: {
                degradation: "divergent",
                note: "Required checks come from rulesets and, for admins, branch protection. Otherwise every failing check counts.",
                supported: true,
            },
            // A check run is re-run through its Actions job where it has one, else by a re-request of the check run.
            rerun: NATIVE,
        },
        // ETag on the list endpoints (a 304 is not counted against the rate limit); a repository webhook signs with the
        // repository secret (`X-Hub-Signature-256`).
        freshness: { conditionalPolling: NATIVE, webhooks: NATIVE },
        inbox: {
            // Search `author:` with `draft:true`.
            drafts: NATIVE,
            mine: NATIVE,
            needsMyReview: NATIVE,
            // Branch protection and required checks are not evaluated: this is "approved and not a draft".
            readyToMerge: { degradation: "synthetic", note: "Approved and not a draft. Branch protection is not checked.", supported: true },
        },
        merge: { auto: NATIVE, now: NATIVE },
        pullRequest: { checks: NATIVE, commits: NATIVE, create: NATIVE, description: NATIVE, diff: NATIVE, files: NATIVE, guide: NATIVE },
        review: {
            batchedSubmit: NATIVE,
            lineComments: NATIVE,
            // The review call takes no reply, so a reply is posted the moment it is sent, not with the review.
            replies: { degradation: "divergent", note: "A reply is posted at once, not with the rest of the review.", supported: true },
            resolveThreads: NATIVE,
            verdictApprove: NATIVE,
            verdictComment: NATIVE,
            verdictRequestChanges: NATIVE,
            viewedMarks: NATIVE,
        },
    },
    reportedAt: 0,
    version: 1,
};

// Enterprise Managed User logins are `handle_shortcode`.
const OWNER = /^[A-Za-z0-9][\w-]{0,99}$/u;
const REPO = /^(?!\.{1,2}$)[\w.-]{1,100}$/u;
const SHA = /^[0-9a-f]{40,64}$/u;

/** `owner/name` split and checked: it becomes two URL path segments. */
export const splitGithubRepo = (repo: string): { name: string; owner: string } | undefined => {
    const [owner, name, ...extra] = repo.split("/");

    return extra.length === 0 && owner !== undefined && name !== undefined && OWNER.test(owner) && REPO.test(name) ? { name, owner } : undefined;
};

const repoPath = (ref: PullRequestRef): string => {
    const parts = splitGithubRepo(ref.repository);

    if (!parts || !Number.isSafeInteger(ref.number) || ref.number < 1) {
        throw new HostApiError("Not a GitHub pull request address", 404);
    }

    return `/repos/${parts.owner}/${parts.name}`;
};

const toMs = (iso: string | null | undefined): number => {
    const ms = iso ? Date.parse(iso) : NaN;

    return Number.isNaN(ms) ? 0 : ms;
};

const webUrl = (url: string | null | undefined): string | null => (url?.startsWith(`${GITHUB_WEB_ORIGIN}/`) ? url : null);

/** A page number from a client: a whole number from 1 to `max`, whatever it sent. */
const clampPage = (page: number, max: number): number => (Number.isFinite(page) ? Math.min(Math.max(Math.trunc(page), 1), max) : 1);

const pageQuery = (page: number, maxPage: number): { page: number; per_page: number } => {
    return { page: clampPage(page, maxPage), per_page: GITHUB_PAGE_SIZE };
};

// ─── Inbox ──────────────────────────────────────────────────────────────────

const searchSchema = z.object({ items: z.array(z.unknown()), total_count: z.number() });

const searchItemSchema = z.object({
    comments: z.number().optional(),
    created_at: z.string(),
    draft: z.boolean().optional(),
    html_url: z.string(),
    labels: z.array(z.object({ name: z.string() })).optional(),
    number: z.int(),
    repository_url: z.string(),
    title: z.string(),
    updated_at: z.string(),
    user: z.object({ login: z.string() }).nullable(),
});

const REPOSITORY_URL = /^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)$/u;

const toSummary = (value: unknown): PullRequestSummary | undefined => {
    const item = searchItemSchema.safeParse(value);
    const repo = item.success ? REPOSITORY_URL.exec(item.data.repository_url)?.[1] : undefined;
    const url = item.success ? webUrl(item.data.html_url) : null;

    if (!item.success || repo === undefined || url === null) {
        return undefined;
    }

    return {
        authorLogin: item.data.user?.login ?? "ghost",
        commentCount: item.data.comments ?? 0,
        createdAt: toMs(item.data.created_at),
        draft: item.data.draft === true,
        labels: (item.data.labels ?? []).map((label) => label.name),
        number: item.data.number,
        repository: repo,
        title: item.data.title,
        updatedAt: toMs(item.data.updated_at),
        url,
    };
};

const SECTION_FILTERS: Record<InboxSection, (login: string) => string> = {
    drafts: (login) => `author:${login} draft:true`,
    mine: (login) => `author:${login}`,
    needsMyReview: (login) => `review-requested:${login} draft:false`,
    readyToMerge: (login) => `author:${login} review:approved draft:false`,
};

/** The search qualifiers of one section, for the signed-in `login`. */
export const inboxQuery = (section: InboxSection, login: string): string => `is:pr is:open archived:false ${SECTION_FILTERS[section](login)}`;

const logins = new WeakMap<HostRequest, Promise<string>>();

/**
 * The signed-in login, read once per requester (one per action), since `@me` is not
 * documented for the REST search. A failed read is not kept, so a retry asks again.
 */
const signedInLogin = (request: HostRequest): Promise<string> => {
    const known = logins.get(request);

    if (known) {
        return known;
    }

    const read = (async () => {
        const user = parse(z.object({ login: z.string() }), await readJson(await request("/user")));

        return user.login;
    })();

    logins.set(request, read);
    read.catch(() => logins.delete(request));

    return read;
};

const listInbox = async (request: HostRequest, section: InboxSection, page: number): Promise<InboxPage> => {
    const current = clampPage(page, GITHUB_INBOX_MAX_PAGE);
    const login = await signedInLogin(request);
    const search = parse(
        searchSchema,
        await readJson(
            await request("/search/issues", {
                query: { order: "desc", page: current, per_page: INBOX_PAGE_SIZE, q: inboxQuery(section, login), sort: "updated" },
            }),
        ),
    );
    const reachable = Math.min(search.total_count, SEARCH_RESULT_LIMIT);

    return {
        hasMore: current < GITHUB_INBOX_MAX_PAGE && current * INBOX_PAGE_SIZE < reachable,
        items: search.items.map((item) => toSummary(item)).filter((item): item is PullRequestSummary => item !== undefined),
        page: current,
        total: search.total_count,
    };
};

// ─── Polling one repository ─────────────────────────────────────────────────

const polledPullSchema = z.object({
    created_at: z.string(),
    draft: z.boolean().optional(),
    html_url: z.string(),
    labels: z.array(z.object({ name: z.string() })).optional(),
    number: z.int(),
    requested_reviewers: z.array(z.object({ login: z.string() })).optional(),
    title: z.string(),
    updated_at: z.string(),
    user: z.object({ login: z.string() }).nullable(),
});

const normalizeRepo = (input: string): string | null => {
    const parts = splitGithubRepo(input.trim());

    return parts ? `${parts.owner}/${parts.name}` : null;
};

const pollReviewRequests = async (request: HostRequest, repo: string, known: { etag: string | null; login: string | null }): Promise<RepoPoll> => {
    const parts = splitGithubRepo(repo);

    if (!parts) {
        throw new HostApiError("Not a GitHub repository address", 404);
    }

    // The login first, only when it is not stored: a poll that finds nothing new is then one request.
    const login = known.login ?? (await signedInLogin(request));
    const response = await request(`/repos/${parts.owner}/${parts.name}/pulls`, {
        // Without a stored validator the list is read in full; with one, an unchanged list answers 304.
        ...(known.etag !== null && known.login !== null && { ifNoneMatch: known.etag }),
        query: { direction: "desc", per_page: GITHUB_POLL_PAGE_SIZE, sort: "updated", state: "open" },
    });

    if (response.status === 304) {
        return { status: "not_modified" };
    }

    const list = parse(z.array(z.unknown()), await readJson(response));
    const wanted = login.toLowerCase();
    const requested: PullRequestSummary[] = [];

    for (const entry of list) {
        const item = polledPullSchema.safeParse(entry);
        const url = item.success ? webUrl(item.data.html_url) : null;

        if (
            !item.success ||
            url === null ||
            item.data.draft === true ||
            (item.data.requested_reviewers ?? []).every((reviewer) => reviewer.login.toLowerCase() !== wanted)
        ) {
            continue;
        }

        requested.push({
            authorLogin: item.data.user?.login ?? "ghost",
            commentCount: 0,
            createdAt: toMs(item.data.created_at),
            draft: false,
            labels: (item.data.labels ?? []).map((label) => label.name),
            number: item.data.number,
            repository: repo,
            title: item.data.title,
            updatedAt: toMs(item.data.updated_at),
            url,
        });
    }

    return { etag: response.headers.get("etag"), login, requested, status: "changed" };
};

// ─── One pull request ───────────────────────────────────────────────────────

const pullSchema = z.object({
    additions: z.number(),
    base: z.object({ ref: z.string() }),
    body: z.string().nullable(),
    changed_files: z.number(),
    commits: z.number(),
    created_at: z.string(),
    deletions: z.number(),
    draft: z.boolean().optional(),
    head: z.object({ ref: z.string(), sha: z.string() }),
    html_url: z.string(),
    merged: z.boolean().optional(),
    number: z.int(),
    state: z.string(),
    title: z.string(),
    updated_at: z.string(),
    user: z.object({ login: z.string() }).nullable(),
});

const pullState = (pull: { merged?: boolean; state: string }): PullRequestDetail["state"] => {
    if (pull.merged === true) {
        return "merged";
    }

    return pull.state === "closed" ? "closed" : "open";
};

const getPullRequest = async (request: HostRequest, ref: PullRequestRef): Promise<PullRequestDetail> => {
    const pull = parse(pullSchema, await readJson(await request(`${repoPath(ref)}/pulls/${ref.number}`)));
    const body = pull.body ?? "";

    return {
        additions: pull.additions,
        authorLogin: pull.user?.login ?? "ghost",
        baseBranch: pull.base.ref,
        body: body.slice(0, BODY_MAX_CHARS),
        bodyTruncated: body.length > BODY_MAX_CHARS,
        changedFiles: pull.changed_files,
        commitCount: pull.commits,
        createdAt: toMs(pull.created_at),
        deletions: pull.deletions,
        draft: pull.draft === true,
        headBranch: pull.head.ref,
        headSha: pull.head.sha,
        number: pull.number,
        repository: ref.repository,
        state: pullState(pull),
        title: pull.title,
        updatedAt: toMs(pull.updated_at),
        url: webUrl(pull.html_url) ?? `${GITHUB_WEB_ORIGIN}/${ref.repository}/pull/${ref.number}`,
    };
};

const commitSchema = z.object({
    commit: z.object({ author: z.object({ date: z.string().optional(), name: z.string().optional() }).nullable(), message: z.string() }),
    sha: z.string(),
});

const listCommits = async (request: HostRequest, ref: PullRequestRef, page: number): Promise<CommitPage> => {
    const { page: current, per_page: perPage } = pageQuery(page, MAX_COMMIT_PAGE);
    const items = parse(
        z.array(z.unknown()),
        await readJson(await request(`${repoPath(ref)}/pulls/${ref.number}/commits`, { query: { page: current, per_page: perPage } })),
    );
    const commits = items.flatMap((item) => {
        const parsed = commitSchema.safeParse(item);

        return parsed.success
            ? [
                  {
                      authorName: parsed.data.commit.author?.name ?? "",
                      committedAt: toMs(parsed.data.commit.author?.date),
                      message: parsed.data.commit.message,
                      sha: parsed.data.sha,
                  },
              ]
            : [];
    });

    return { commits, hasMore: items.length === perPage && current < MAX_COMMIT_PAGE, page: current };
};

const FILE_STATUSES = new Set<string>(["added", "changed", "copied", "modified", "removed", "renamed", "unchanged"]);

const fileSchema = z.object({
    additions: z.number(),
    deletions: z.number(),
    filename: z.string(),
    patch: z.string().optional(),
    previous_filename: z.string().optional(),
    status: z.string(),
});

/** Keeps each file's patch within its own ceiling and the page within one budget, in the host's order. */
const fitPatches = (files: PullRequestFile[]): PullRequestFile[] => {
    let remaining = PAGE_PATCH_BUDGET_CHARS;

    return files.map((file) => {
        if (file.patch === null) {
            return file;
        }

        const allowed = Math.min(PATCH_MAX_CHARS, remaining);

        if (file.patch.length <= allowed) {
            remaining -= file.patch.length;

            return file;
        }

        if (allowed === 0) {
            return { ...file, patch: null, patchState: "over_budget" as const };
        }

        remaining -= allowed;

        return { ...file, patch: file.patch.slice(0, allowed), patchState: "truncated" as const };
    });
};

const toFile = (value: unknown): PullRequestFile | undefined => {
    const parsed = fileSchema.safeParse(value);

    if (!parsed.success) {
        return undefined;
    }

    const { data } = parsed;

    return {
        additions: data.additions,
        deletions: data.deletions,
        patch: data.patch ?? null,
        patchState: data.patch === undefined ? "host_omitted" : "full",
        path: data.filename,
        previousPath: data.previous_filename ?? null,
        status: (FILE_STATUSES.has(data.status) ? data.status : "changed") as FileStatus,
    };
};

const listFiles = async (request: HostRequest, ref: PullRequestRef, page: number): Promise<FilePage> => {
    const { page: current, per_page: perPage } = pageQuery(page, MAX_FILE_PAGE);
    const items = parse(
        z.array(z.unknown()),
        await readJson(await request(`${repoPath(ref)}/pulls/${ref.number}/files`, { query: { page: current, per_page: perPage } })),
    );
    const files = items.map((item) => toFile(item)).filter((file): file is PullRequestFile => file !== undefined);

    return { files: fitPatches(files), hasMore: items.length === perPage && current < MAX_FILE_PAGE, page: current };
};

// ─── Review ─────────────────────────────────────────────────────────────────

/** Cursor pages the review reads ask for: 100 files, 50 threads with their first 30 comments (the rest of a long thread is read on, up to {@link MAX_THREAD_COMMENT_PAGES} more pages). */
const VIEWED_PAGE_SIZE = 100;
const THREAD_PAGE_SIZE = 50;
const THREAD_COMMENTS = 30;
const MAX_THREAD_COMMENT_PAGES = 4;
const COMMENT_PAGE_SIZE = 100;
const COMMENT_MAX_CHARS = 20_000;
const COMMENT_ID = /^\d{1,20}$/u;
const NODE_ID = /^[\w=-]{1,200}$/u;

const EVENTS = { approve: "APPROVE", comment: "COMMENT", request_changes: "REQUEST_CHANGES" } as const;

const HOST_SIDES = { new: "RIGHT", old: "LEFT" } as const satisfies Record<DiffSide, string>;

const pageInfoSchema = z.object({ endCursor: z.string().nullable(), hasNextPage: z.boolean() });

const sideOf = (side: string): DiffSide => (side === "LEFT" ? "old" : "new");

const repoParts = (ref: PullRequestRef): { name: string; number: number; owner: string } => {
    const parts = splitGithubRepo(ref.repository);

    if (!parts || !Number.isSafeInteger(ref.number) || ref.number < 1) {
        throw new HostApiError("Not a GitHub pull request address", 404);
    }

    return { ...parts, number: ref.number };
};

const pullRequestOf = <T>(repo: { pullRequest: T | null } | null): T => {
    if (repo?.pullRequest == null) {
        throw new HostApiError("The pull request was not found", 404);
    }

    return repo.pullRequest;
};

const THREADS_QUERY = `query ($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: ${THREAD_PAGE_SIZE}, after: $after) {
        pageInfo { endCursor hasNextPage }
        nodes {
          id isResolved isOutdated path line startLine diffSide viewerCanResolve viewerCanUnresolve
          comments(first: ${THREAD_COMMENTS}) { pageInfo { endCursor hasNextPage } nodes { fullDatabaseId author { login } body createdAt } }
        }
      }
    }
  }
}`;

/** The comments of one thread after a cursor: the rest of a thread the first page did not hold. */
const COMMENTS_QUERY = `query ($id: ID!, $after: String) {
  node(id: $id) {
    ... on PullRequestReviewThread {
      comments(first: ${COMMENT_PAGE_SIZE}, after: $after) { pageInfo { endCursor hasNextPage } nodes { fullDatabaseId author { login } body createdAt } }
    }
  }
}`;

const commentsSchema = z.object({ nodes: z.array(z.unknown()), pageInfo: pageInfoSchema.optional() });

const commentsDataSchema = z.object({ node: z.object({ comments: commentsSchema }).nullable() });

const threadCommentSchema = z.object({
    author: z.object({ login: z.string() }).nullable(),
    body: z.string(),
    createdAt: z.string(),
    fullDatabaseId: z.union([z.string(), z.number()]),
});

const threadSchema = z.object({
    comments: commentsSchema,
    diffSide: z.string(),
    id: z.string(),
    isOutdated: z.boolean(),
    isResolved: z.boolean(),
    line: z.number().nullable(),
    path: z.string(),
    startLine: z.number().nullable(),
    viewerCanResolve: z.boolean(),
    viewerCanUnresolve: z.boolean(),
});

const threadsDataSchema = z.object({
    repository: z
        .object({ pullRequest: z.object({ reviewThreads: z.object({ nodes: z.array(z.unknown()), pageInfo: pageInfoSchema }) }).nullable() })
        .nullable(),
});

const commentsOf = (nodes: unknown[]): ThreadComment[] =>
    nodes.flatMap((node) => {
        const comment = threadCommentSchema.safeParse(node);
        const id = comment.success ? String(comment.data.fullDatabaseId) : "";

        return comment.success && COMMENT_ID.test(id)
            ? [
                  {
                      authorLogin: comment.data.author?.login ?? "ghost",
                      body: comment.data.body.slice(0, COMMENT_MAX_CHARS),
                      createdAt: toMs(comment.data.createdAt),
                      id,
                  },
              ]
            : [];
    });

/** A thread's comments past the first page, a page at a time up to {@link MAX_THREAD_COMMENT_PAGES}; a longer thread ends there. */
const laterComments = async (request: HostRequest, threadId: string, first: z.infer<typeof commentsSchema>): Promise<unknown[]> => {
    const nodes: unknown[] = [];
    let { pageInfo } = first;

    for (let page = 0; pageInfo?.hasNextPage && pageInfo.endCursor !== null && page < MAX_THREAD_COMMENT_PAGES; page += 1) {
        const data = await graphqlRequest(request, COMMENTS_QUERY, { after: pageInfo.endCursor, id: threadId }, commentsDataSchema);

        if (data.node === null) {
            break;
        }

        nodes.push(...data.node.comments.nodes);
        pageInfo = data.node.comments.pageInfo;
    }

    return nodes;
};

const toThread = async (request: HostRequest, value: unknown): Promise<ReviewThread | undefined> => {
    const thread = threadSchema.safeParse(value);

    if (!thread.success) {
        return undefined;
    }

    const comments = commentsOf([...thread.data.comments.nodes, ...(await laterComments(request, thread.data.id, thread.data.comments))]);

    return {
        canResolve: thread.data.viewerCanResolve,
        canUnresolve: thread.data.viewerCanUnresolve,
        comments,
        id: thread.data.id,
        isOutdated: thread.data.isOutdated,
        isResolved: thread.data.isResolved,
        line: thread.data.line,
        path: thread.data.path,
        side: sideOf(thread.data.diffSide),
        startLine: thread.data.startLine,
    };
};

const listThreads = async (request: HostRequest, ref: PullRequestRef, after: string | null): Promise<CursorPage<ReviewThread>> => {
    const data = await graphqlRequest(request, THREADS_QUERY, { ...repoParts(ref), after }, threadsDataSchema);
    const { reviewThreads } = pullRequestOf(data.repository);
    const threads = await Promise.all(reviewThreads.nodes.map(async (node) => await toThread(request, node)));

    return {
        endCursor: reviewThreads.pageInfo.endCursor,
        hasMore: reviewThreads.pageInfo.hasNextPage,
        items: threads.filter((thread): thread is ReviewThread => thread !== undefined),
    };
};

const replySchema = z.object({ id: z.number() });

const replyToThread = async (request: HostRequest, ref: PullRequestRef, commentId: string, body: string): Promise<{ id: string }> => {
    if (!COMMENT_ID.test(commentId)) {
        throw new HostApiError("Not a comment id", 404);
    }

    const response = await request(`${repoPath(ref)}/pulls/${ref.number}/comments/${commentId}/replies`, { json: { body }, method: "POST" });
    let reply: z.infer<typeof replySchema>;

    try {
        reply = parse(replySchema, await readJson(response));
    } catch {
        // The host answered 2xx, so it took the reply; a retry would post it a second time.
        throw new HostApiError("The host's answer to the reply could not be read", 0, false, { unconfirmed: true });
    }

    return { id: String(reply.id) };
};

const RESOLVE_MUTATION = `mutation ($threadId: ID!) { resolveReviewThread(input: { threadId: $threadId }) { thread { id isResolved } } }`;
const UNRESOLVE_MUTATION = `mutation ($threadId: ID!) { unresolveReviewThread(input: { threadId: $threadId }) { thread { id isResolved } } }`;

const resolvedSchema = z.object({ thread: z.object({ isResolved: z.boolean() }) });

const setThreadResolved = async (request: HostRequest, threadId: string, resolved: boolean): Promise<void> => {
    if (!NODE_ID.test(threadId)) {
        throw new HostApiError("Not a thread id", 404);
    }

    const data = await graphqlRequest(
        request,
        resolved ? RESOLVE_MUTATION : UNRESOLVE_MUTATION,
        { threadId },
        z.object({ resolveReviewThread: resolvedSchema.optional(), unresolveReviewThread: resolvedSchema.optional() }),
    );
    const confirmed = (resolved ? data.resolveReviewThread : data.unresolveReviewThread)?.thread.isResolved;

    // A mutation that answers without the state asked for did not do it.
    if (confirmed !== resolved) {
        throw new HostApiError("The host did not confirm the thread change", 0);
    }
};

const VIEWED_QUERY = `query ($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      files(first: ${VIEWED_PAGE_SIZE}, after: $after) {
        pageInfo { endCursor hasNextPage }
        nodes { path viewerViewedState }
      }
    }
  }
}`;

const VIEWED_STATES: Record<string, ViewedState> = { DISMISSED: "changed", VIEWED: "viewed" };

const viewedDataSchema = z.object({
    repository: z
        .object({
            pullRequest: z
                .object({
                    files: z.object({
                        nodes: z.array(z.object({ path: z.string(), viewerViewedState: z.string() })),
                        pageInfo: pageInfoSchema,
                    }),
                })
                .nullable(),
        })
        .nullable(),
});

const listViewed = async (request: HostRequest, ref: PullRequestRef, after: string | null): Promise<CursorPage<ViewedFile>> => {
    const data = await graphqlRequest(request, VIEWED_QUERY, { ...repoParts(ref), after }, viewedDataSchema);
    const { files } = pullRequestOf(data.repository);

    return {
        endCursor: files.pageInfo.endCursor,
        hasMore: files.pageInfo.hasNextPage,
        items: files.nodes.map((node) => {
            return { path: node.path, state: VIEWED_STATES[node.viewerViewedState] ?? "unviewed" };
        }),
    };
};

const PULL_ID_QUERY = `query ($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) { id } }
}`;
const MARK_VIEWED_MUTATION = `mutation ($pullRequestId: ID!, $path: String!) { markFileAsViewed(input: { pullRequestId: $pullRequestId, path: $path }) { clientMutationId } }`;
const UNMARK_VIEWED_MUTATION = `mutation ($pullRequestId: ID!, $path: String!) { unmarkFileAsViewed(input: { pullRequestId: $pullRequestId, path: $path }) { clientMutationId } }`;

/** The GraphQL node id of a pull request, which the host's mutations address it by. */
const pullNodeId = async (request: HostRequest, ref: PullRequestRef): Promise<string> => {
    const data = await graphqlRequest(
        request,
        PULL_ID_QUERY,
        repoParts(ref),
        z.object({ repository: z.object({ pullRequest: z.object({ id: z.string() }).nullable() }).nullable() }),
    );

    return pullRequestOf(data.repository).id;
};

const setViewed = async (request: HostRequest, ref: PullRequestRef, path: string, viewed: boolean): Promise<void> => {
    const pullRequestId = await pullNodeId(request, ref);

    // The mutation's own field must come back: a null or empty `data` is a call the host did not act on.
    await graphqlRequest(
        request,
        viewed ? MARK_VIEWED_MUTATION : UNMARK_VIEWED_MUTATION,
        { path, pullRequestId },
        z.object({ [viewed ? "markFileAsViewed" : "unmarkFileAsViewed"]: z.object({}).passthrough() }),
    );
};

const reviewSchema = z.object({ html_url: z.string().optional(), id: z.number(), state: z.string() });

/** One `POST .../reviews`: every comment, the verdict and the commit in the same call. */
const submitReview = async (request: HostRequest, ref: PullRequestRef, submission: ReviewSubmission): Promise<SubmittedReview> => {
    if (!SHA.test(submission.commitId)) {
        throw new HostApiError("Not a commit id", 404);
    }

    const response = await request(`${repoPath(ref)}/pulls/${ref.number}/reviews`, {
        json: {
            body: submission.body,
            comments: submission.comments.map((comment) => {
                return {
                    body: comment.body,
                    line: comment.line,
                    path: comment.path,
                    side: HOST_SIDES[comment.side],
                    ...(comment.startLine !== null && { start_line: comment.startLine, start_side: HOST_SIDES[comment.side] }),
                };
            }),
            commit_id: submission.commitId,
            event: EVENTS[submission.verdict],
        },
        method: "POST",
    });
    let review: z.infer<typeof reviewSchema>;

    try {
        review = parse(reviewSchema, await readJson(response));
    } catch {
        // The host answered 2xx, so it took the review; we just cannot say which one it is.
        throw new HostApiError("The host's answer to the review could not be read", 0, false, { unconfirmed: true });
    }

    // With an event the review is submitted; a pending one is not a review anybody can see yet, and
    // while it exists GitHub refuses the reviewer another, so a retry would fail: the wording says so.
    if (review.state === "PENDING") {
        throw new HostApiError("The host kept the review as a pending draft, which blocks another review", 0, false, { unconfirmed: true });
    }

    return { id: String(review.id), url: webUrl(review.html_url) };
};

// ─── Checks ─────────────────────────────────────────────────────────────────

const checkRunsSchema = z.object({
    check_runs: z.array(z.unknown()),
    total_count: z.number(),
});

const checkRunSchema = z.object({
    conclusion: z.string().nullable(),
    html_url: z.string().nullable().optional(),
    id: z.number().optional(),
    name: z.string(),
    status: z.string(),
});

const commitStatusSchema = z.object({
    statuses: z.array(z.unknown()),
    total_count: z.number().optional(),
});

const statusSchema = z.object({ context: z.string(), state: z.string(), target_url: z.string().nullable().optional() });

const CONCLUSIONS: Record<string, CheckState> = {
    action_required: "failure",
    cancelled: "cancelled",
    failure: "failure",
    neutral: "neutral",
    skipped: "skipped",
    stale: "neutral",
    startup_failure: "failure",
    success: "success",
    timed_out: "failure",
};

const runState = (status: string, conclusion: string | null): CheckState =>
    status === "completed" && conclusion !== null ? (CONCLUSIONS[conclusion] ?? "neutral") : "pending";

const STATUS_STATES: Record<string, CheckState> = { error: "failure", failure: "failure", success: "success" };

const statusState = (state: string): CheckState => STATUS_STATES[state] ?? "pending";

/** Longest branch name that is read; a longer one is treated as unreadable rather than sent. */
const BRANCH_MAX_CHARS = 250;

/**
 * A branch name as a URL path, one encoded segment at a time, or `undefined` when it cannot be one safely. Git allows
 * almost any character in a name, so the characters are not limited, only the segments that would walk the path
 * (`.`, `..`) or vanish (empty).
 */
const branchPath = (branch: string): string | undefined => {
    const segments = branch.split("/");

    if (branch.length > BRANCH_MAX_CHARS || segments.some((segment) => ["", ".", ".."].includes(segment))) {
        return undefined;
    }

    try {
        return segments.map((segment) => encodeURIComponent(segment)).join("/");
    } catch {
        // A lone surrogate cannot be encoded.
        return undefined;
    }
};

const createdPullRequestSchema = z.object({ html_url: z.string().nullable().optional(), number: z.int().positive() });

/**
 * Opens a pull request for a branch that is already pushed, and answers its web page. The branch names become JSON
 * values (never a URL path), and the repository address is the host's own `owner/name`.
 *
 * A 2xx whose body cannot be read is NOT a failure to report as "nothing happened": the host may have opened it, so the
 * answer is marked unconfirmed and a caller looks before trying again.
 */
const createPullRequest = async (request: HostRequest, input: CreatePullRequestInput): Promise<CreatedPullRequest> => {
    const parts = splitGithubRepo(input.repository);

    if (!parts) {
        throw new HostApiError("Not a GitHub pull request address", 404);
    }

    // The names are JSON values, not path parts: `branchPath` only vets them (an encoded `+` would name another branch).
    if (branchPath(input.base) === undefined || branchPath(input.head) === undefined) {
        throw new HostApiError("Not a branch this can open a pull request from", 404);
    }

    const response = await request(`/repos/${parts.owner}/${parts.name}/pulls`, {
        json: { base: input.base, body: input.body, head: input.head, title: input.title },
        method: "POST",
    });
    let created: z.infer<typeof createdPullRequestSchema>;

    try {
        created = parse(createdPullRequestSchema, await readJson(response));
    } catch {
        // The host answered 2xx, so it took the request; we just cannot say which pull request it is.
        throw new HostApiError("The host's answer to the pull request could not be read", 0, false, { unconfirmed: true });
    }

    return { url: webUrl(created.html_url) ?? `${GITHUB_WEB_ORIGIN}/${parts.owner}/${parts.name}/pull/${String(created.number)}` };
};

const openPullRequestsSchema = z.array(z.object({ html_url: z.string().nullable().optional(), number: z.int().positive() }));

/** The open pull request from a branch of the repository itself, or `undefined`. The head is `owner:branch`, as the host wants it. */
const findOpenPullRequest = async (request: HostRequest, input: { head: string; repository: string }): Promise<CreatedPullRequest | undefined> => {
    const parts = splitGithubRepo(input.repository);

    if (!parts || branchPath(input.head) === undefined) {
        return undefined;
    }

    const response = await request(`/repos/${parts.owner}/${parts.name}/pulls`, {
        query: { head: `${parts.owner}:${input.head}`, per_page: 1, state: "open" },
    });
    const [found] = parse(openPullRequestsSchema, await readJson(response));

    return found === undefined
        ? undefined
        : { url: webUrl(found.html_url) ?? `${GITHUB_WEB_ORIGIN}/${parts.owner}/${parts.name}/pull/${String(found.number)}` };
};

/** Reads a source of required-check rules, which may be withheld: only a sign-in or rate-limit problem is the caller's. */
const readable = async <T>(read: () => Promise<T>): Promise<T | undefined> => {
    try {
        return await read();
    } catch (error) {
        if (!(error instanceof HostApiError) || error.status === 401 || error.rateLimited) {
            throw error;
        }

        return undefined;
    }
};

const rulesSchema = z.array(
    z.object({
        // Other rules (`pull_request`, `merge_queue`...) carry parameters of their own, without this key.
        parameters: z.object({ required_status_checks: z.array(z.object({ context: z.string() })).optional() }).optional(),
        type: z.string(),
    }),
);

const protectionSchema = z.object({ checks: z.array(z.object({ context: z.string() })).optional(), contexts: z.array(z.string()) });

/**
 * The required-check patterns of the rulesets that apply to `branch`; anyone who can read the repository can read these.
 * `complete` is false when the rules fill a whole page: the host may hold more.
 */
const rulesetPatterns = async (request: HostRequest, ref: PullRequestRef, branch: string): Promise<{ complete: boolean; patterns: string[] }> => {
    const rules = parse(rulesSchema, await readJson(await request(`${repoPath(ref)}/rules/branches/${branch}`, { query: { per_page: GITHUB_PAGE_SIZE } })));

    return {
        complete: rules.length < GITHUB_PAGE_SIZE,
        patterns: rules.flatMap((rule) =>
            rule.type === "required_status_checks" ? (rule.parameters?.required_status_checks ?? []).map((check) => check.context) : [],
        ),
    };
};

const branchSchema = z.object({
    protected: z.boolean(),
    protection: z.object({ required_status_checks: protectionSchema.partial().nullable().optional() }).optional(),
});

const contextsOf = (protection: { checks?: { context: string }[]; contexts?: string[] }): string[] => [
    ...(protection.contexts ?? []),
    ...(protection.checks ?? []).map((check) => check.context),
];

/**
 * The patterns of legacy branch protection, or `undefined` when they cannot be told. The host answers 404 both for a branch
 * with no protection and for a reader it will not show the settings to, so a 404 means "none" only when the branch itself
 * says it is not protected; otherwise the branch's own summary is used, and failing that the answer stays unknown.
 */
const protectionPatterns = async (request: HostRequest, ref: PullRequestRef, branch: string): Promise<string[] | undefined> => {
    const repo = repoPath(ref);
    const info = parse(branchSchema, await readJson(await request(`${repo}/branches/${branch}`)));

    if (!info.protected) {
        return [];
    }

    try {
        return contextsOf(parse(protectionSchema, await readJson(await request(`${repo}/branches/${branch}/protection/required_status_checks`))));
    } catch (error) {
        if (!(error instanceof HostApiError) || error.rateLimited || ![403, 404].includes(error.status)) {
            throw error;
        }
    }

    const summary = info.protection?.required_status_checks;

    return summary ? contextsOf(summary) : undefined;
};

const baseSchema = z.object({ base: z.object({ ref: z.string() }) });

/** What the base branch's rules require; a source that cannot be read leaves `complete` false. */
const requiredChecksOf = async (request: HostRequest, ref: PullRequestRef): Promise<RequiredChecks> => {
    const pull = await readable(async () => parse(baseSchema, await readJson(await request(`${repoPath(ref)}/pulls/${ref.number}`))));

    if (pull === undefined) {
        return { complete: false, patterns: [] };
    }

    const branch = branchPath(pull.base.ref);

    if (branch === undefined) {
        return { complete: false, patterns: [] };
    }

    const [rulesets, protection] = await Promise.all([
        readable(async () => await rulesetPatterns(request, ref, branch)),
        readable(async () => await protectionPatterns(request, ref, branch)),
    ]);

    return {
        complete: rulesets?.complete === true && protection !== undefined,
        patterns: [...(rulesets?.patterns ?? []), ...(protection ?? [])],
    };
};

const listChecks = async (request: HostRequest, ref: PullRequestRef, headSha: string): Promise<CheckSummary> => {
    if (!SHA.test(headSha)) {
        throw new HostApiError("Not a commit id", 404);
    }

    const base = `${repoPath(ref)}/commits/${headSha}`;
    const settled = await Promise.allSettled([
        request(`${base}/check-runs`, { query: { per_page: GITHUB_PAGE_SIZE } }),
        request(`${base}/status`, { query: { per_page: GITHUB_PAGE_SIZE } }),
    ]);
    const rejected = settled.find((outcome) => outcome.status === "rejected");

    if (rejected) {
        // The other request may have succeeded: its body is still open and nobody will read it.
        await Promise.all(settled.map(async (outcome) => (outcome.status === "fulfilled" ? await discard(outcome.value) : undefined)));

        throw rejected.reason;
    }

    const [runsResponse, statusResponse] = settled.flatMap((outcome) => (outcome.status === "fulfilled" ? [outcome.value] : []));

    if (!runsResponse || !statusResponse) {
        throw new HostApiError("The host did not answer", 0);
    }

    let runs: z.infer<typeof checkRunsSchema>;

    try {
        runs = parse(checkRunsSchema, await readJson(runsResponse));
    } catch (error) {
        await discard(statusResponse);

        throw error;
    }

    const statuses = parse(commitStatusSchema, await readJson(statusResponse));
    const required = await requiredChecksOf(request, ref);
    const checks: CheckRun[] = [
        ...runs.check_runs.flatMap((value) => {
            const run = checkRunSchema.safeParse(value);

            return run.success
                ? [
                      {
                          id: run.data.id !== undefined && Number.isSafeInteger(run.data.id) ? String(run.data.id) : null,
                          name: run.data.name,
                          required: requirementOf(run.data.name, required),
                          state: runState(run.data.status, run.data.conclusion),
                          url: webUrl(run.data.html_url),
                      },
                  ]
                : [];
        }),
        ...statuses.statuses.flatMap((value) => {
            const status = statusSchema.safeParse(value);

            // A status's link is the CI system's own, not a GitHub address: it is not kept. A status cannot be re-run.
            return status.success
                ? [
                      {
                          id: null,
                          name: status.data.context,
                          required: requirementOf(status.data.context, required),
                          state: statusState(status.data.state),
                          url: null,
                      },
                  ]
                : [];
        }),
    ];

    return { checks, required, total: runs.total_count + (statuses.total_count ?? statuses.statuses.length) };
};

const runAppSchema = z.object({ app: z.object({ slug: z.string() }).nullable().optional() });

/** Actions runs a check run as a job, which can be re-run alone; any other app's check is asked to run again. */
const ACTIONS_APP = "github-actions";

const rerunCheck = async (request: HostRequest, ref: PullRequestRef, checkId: string): Promise<void> => {
    if (!COMMENT_ID.test(checkId)) {
        throw new HostApiError("Not a check id", 404);
    }

    const repo = repoPath(ref);
    const run = parse(runAppSchema, await readJson(await request(`${repo}/check-runs/${checkId}`)));
    const path = run.app?.slug === ACTIONS_APP ? `${repo}/actions/jobs/${checkId}/rerun` : `${repo}/check-runs/${checkId}/rerequest`;

    try {
        await discard(await request(path, { json: {}, method: "POST" }));
    } catch (error) {
        // A 403 that is not a rate limit and says why ("cannot re-run a job while other jobs in the run are in progress") is a
        // refusal of this call, not a lack of access: the reason is what the person needs.
        if (error instanceof HostApiError && error.status === 403 && !error.rateLimited && error.detail !== undefined) {
            throw new HostApiError(error.message, 422, false, { detail: error.detail });
        }

        throw error;
    }
};

// ─── Merge ──────────────────────────────────────────────────────────────────

const mergeSettingsSchema = z.object({
    allow_auto_merge: z.boolean().optional(),
    allow_merge_commit: z.boolean().optional(),
    allow_rebase_merge: z.boolean().optional(),
    allow_squash_merge: z.boolean().optional(),
});

const mergeabilitySchema = z.object({
    auto_merge: z.unknown().nullable().optional(),
    mergeable_state: z.string().optional(),
});

const MERGE_STATES: Record<string, MergeState> = {
    behind: "behind",
    blocked: "blocked",
    clean: "clean",
    dirty: "conflicting",
    draft: "draft",
    has_hooks: "clean",
    unstable: "unstable",
};

const getMergeStatus = async (request: HostRequest, ref: PullRequestRef): Promise<MergeStatus> => {
    const repo = repoPath(ref);
    const settings = parse(mergeSettingsSchema, await readJson(await request(repo)));
    const pull = parse(mergeabilitySchema, await readJson(await request(`${repo}/pulls/${ref.number}`)));
    const allowed: [MergeMethod, boolean | undefined][] = [
        ["merge", settings.allow_merge_commit],
        ["squash", settings.allow_squash_merge],
        ["rebase", settings.allow_rebase_merge],
    ];

    return {
        autoMergeAllowed: settings.allow_auto_merge === true,
        autoMergeEnabled: pull.auto_merge != null,
        methods: allowed.flatMap(([method, on]) => (on === true ? [method] : [])),
        state: MERGE_STATES[pull.mergeable_state ?? ""] ?? "unknown",
    };
};

const mergedSchema = z.object({ merged: z.boolean(), message: z.string().optional(), sha: z.string().nullish() });

const mergedPullSchema = z.object({ head: z.object({ sha: z.string() }), merge_commit_sha: z.string().nullable().optional(), merged: z.boolean().optional() });

/**
 * Whether the pull request is already merged at `headSha`: a second tab's merge, or a retry, is then the same merge done,
 * not a refusal. `undefined` when the host answered that it is not; a read that could not be answered (rate limited, down, unreadable) is
 * unconfirmed, because the merge may have happened.
 */
const alreadyMerged = async (request: HostRequest, ref: PullRequestRef, headSha: string): Promise<MergedPullRequest | undefined> => {
    try {
        const pull = parse(mergedPullSchema, await readJson(await request(`${repoPath(ref)}/pulls/${ref.number}`)));

        return pull.merged === true && pull.head.sha === headSha ? { sha: pull.merge_commit_sha ?? null } : undefined;
    } catch (error) {
        // A read the host answered with a refusal says nothing about the merge; one it could not answer (throttled, down, unreadable) may hide it.
        if (error instanceof HostApiError && (error.rateLimited || error.status === 0 || error.status >= 500)) {
            throw new HostApiError("The host could not say whether the pull request was merged", 0, false, { unconfirmed: true });
        }

        if (error instanceof HostApiError) {
            return undefined;
        }

        throw error;
    }
};

/** One `PUT .../merge` naming the head the person saw: the host merges that commit or refuses, with its reason. */
const mergePullRequest = async (request: HostRequest, ref: PullRequestRef, merge: MergeRequest): Promise<MergedPullRequest> => {
    if (!SHA.test(merge.headSha)) {
        throw new HostApiError("Not a commit id", 404);
    }

    let response: Response;

    try {
        response = await request(`${repoPath(ref)}/pulls/${ref.number}/merge`, { json: { merge_method: merge.method, sha: merge.headSha }, method: "PUT" });
    } catch (error) {
        // 405 ("not mergeable") and 409 ("head modified") are also what a merge that already happened answers.
        if (error instanceof HostApiError && !error.rateLimited && [405, 409].includes(error.status)) {
            const done = await alreadyMerged(request, ref, merge.headSha);

            if (done) {
                return done;
            }
        }

        throw error;
    }

    let result: z.infer<typeof mergedSchema>;

    try {
        result = parse(mergedSchema, await readJson(response));
    } catch {
        // The host answered 2xx, so it merged; we just cannot say which commit.
        throw new HostApiError("The host's answer to the merge could not be read", 0, false, { unconfirmed: true });
    }

    if (!result.merged) {
        throw new HostApiError("The host did not merge", 405, false, { detail: result.message });
    }

    return { sha: result.sha ?? null };
};

const AUTO_MERGE_METHODS = { merge: "MERGE", rebase: "REBASE", squash: "SQUASH" } as const satisfies Record<MergeMethod, string>;

const ENABLE_AUTO_MERGE = `mutation ($pullRequestId: ID!, $method: PullRequestMergeMethod!, $expectedHeadOid: GitObjectID!) {
  enablePullRequestAutoMerge(input: { pullRequestId: $pullRequestId, mergeMethod: $method, expectedHeadOid: $expectedHeadOid }) { pullRequest { autoMergeRequest { enabledAt } } }
}`;
const DISABLE_AUTO_MERGE = `mutation ($pullRequestId: ID!) {
  disablePullRequestAutoMerge(input: { pullRequestId: $pullRequestId }) { pullRequest { autoMergeRequest { enabledAt } } }
}`;

const autoMergeResultSchema = z.object({ pullRequest: z.object({ autoMergeRequest: z.unknown().nullable() }) });

const setAutoMerge = async (request: HostRequest, ref: PullRequestRef, enabled: boolean, method: MergeMethod, headSha: string): Promise<void> => {
    // Turning it on names the head the person looked at, so a branch that moved since is not merged unseen.
    if (enabled && !SHA.test(headSha)) {
        throw new HostApiError("Not a commit id", 404);
    }

    const pullRequestId = await pullNodeId(request, ref);
    const data = await graphqlRequest(
        request,
        enabled ? ENABLE_AUTO_MERGE : DISABLE_AUTO_MERGE,
        enabled ? { expectedHeadOid: headSha, method: AUTO_MERGE_METHODS[method], pullRequestId } : { pullRequestId },
        z.object({ disablePullRequestAutoMerge: autoMergeResultSchema.optional(), enablePullRequestAutoMerge: autoMergeResultSchema.optional() }),
    );
    const result = enabled ? data.enablePullRequestAutoMerge : data.disablePullRequestAutoMerge;

    // A mutation that answers without the state asked for did not do it.
    if (result === undefined || (result.pullRequest.autoMergeRequest != null) !== enabled) {
        throw new HostApiError("The host did not confirm the auto-merge change", 0);
    }
};

export const githubDriver: HostDriver = {
    apiOrigin: GITHUB_API_ORIGIN,
    createPullRequest,
    findOpenPullRequest,
    getMergeStatus,
    getPullRequest,
    headers: { Accept: "application/vnd.github+json", "User-Agent": "neore-chat", "X-GitHub-Api-Version": "2022-11-28" },
    kind: "github",
    listChecks,
    listCommits,
    listFiles,
    listInbox,
    listThreads,
    listViewed,
    mergePullRequest,
    normalizeRepository: normalizeRepo,
    pollReviewRequests,
    replyToThread,
    rerunCheck,
    setAutoMerge,
    setThreadResolved,
    setViewed,
    submitReview,
    view: {
        capabilities: GITHUB_CAPABILITIES,
        connectorSlug: "github",
        label: "GitHub",
        limits: { commits: GITHUB_COMMIT_LIMIT, files: GITHUB_FILE_LIMIT },
        requestNoun: "pull request",
    },
    webhookScheme: "native",
    webOrigin: GITHUB_WEB_ORIGIN,
};
