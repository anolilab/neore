/**
 * Host-neutral shapes a driver returns. Host ids and addressing stay inside the
 * driver; everything here reads the same for every host. Times are epoch
 * milliseconds. Every string that came from the host (titles, bodies, branch
 * and check names, patches) is untrusted text: render it as text.
 */
import type { HostCapabilityReport } from "./capabilities";

export const INBOX_SECTIONS = ["needsMyReview", "mine", "readyToMerge", "drafts"] as const;

export type InboxSection = (typeof INBOX_SECTIONS)[number];

/** A pull request (or merge request) by repository path and number. */
export interface PullRequestRef {
    number: number;
    /** `owner/name`, or the path the host's identity parser produced. */
    repository: string;
}

export interface PullRequestSummary extends PullRequestRef {
    authorLogin: string;
    commentCount: number;
    createdAt: number;
    draft: boolean;
    labels: string[];
    title: string;
    updatedAt: number;
    url: string;
}

export interface InboxPage {
    hasMore: boolean;
    items: PullRequestSummary[];
    page: number;
    /** What the host reports as matching; the list may stop earlier at the host's own search ceiling. */
    total: number;
}

export interface PullRequestDetail extends PullRequestRef {
    additions: number;
    authorLogin: string;
    baseBranch: string;
    body: string;
    bodyTruncated: boolean;
    changedFiles: number;
    commitCount: number;
    createdAt: number;
    deletions: number;
    draft: boolean;
    headBranch: string;
    headSha: string;
    state: "closed" | "merged" | "open";
    title: string;
    updatedAt: number;
    url: string;
}

export interface PullRequestCommit {
    authorName: string;
    committedAt: number;
    /** The whole message; the first line is the subject. */
    message: string;
    sha: string;
}

export interface CommitPage {
    commits: PullRequestCommit[];
    hasMore: boolean;
    page: number;
}

/**
 * - `full`: the host's patch, unchanged.
 * - `truncated`: cut at the per-file ceiling, or where this page's budget ran out.
 * - `host_omitted`: the host sent none (binary, or too large for it).
 * - `over_budget`: left out entirely: this page's budget was already spent.
 */
export type PatchState = "full" | "host_omitted" | "over_budget" | "truncated";

export type FileStatus = "added" | "changed" | "copied" | "modified" | "removed" | "renamed" | "unchanged";

export interface PullRequestFile {
    additions: number;
    deletions: number;
    patch: string | null;
    patchState: PatchState;
    path: string;
    previousPath: string | null;
    status: FileStatus;
}

export interface FilePage {
    files: PullRequestFile[];
    hasMore: boolean;
    page: number;
}

export type CheckState = "cancelled" | "failure" | "neutral" | "pending" | "skipped" | "success";

export interface CheckRun {
    /** The host's id for a check that can be re-run on its own; `null` for one that cannot (a commit status). */
    id: string | null;
    name: string;
    /** Whether the base branch's rules require it: `null` when they could not be read, which counts as required. */
    required: boolean | null;
    state: CheckState;
    url: string | null;
}

/** The patterns a branch's rules require, and whether every source of those rules could be read. */
export interface RequiredChecks {
    /** `false` when a source was unreadable: a check no pattern names is then unknown, not optional. */
    complete: boolean;
    patterns: string[];
}

export interface CheckSummary {
    checks: CheckRun[];
    /** The rules' required-check patterns: a required check that has not reported is not in `checks`. */
    required: RequiredChecks;
    /** How many the host reports; `checks` holds at most one bounded page of them. */
    total: number;
}

// ─── Merge ──────────────────────────────────────────────────────────────────

export const MERGE_METHODS = ["merge", "squash", "rebase"] as const;

export type MergeMethod = (typeof MERGE_METHODS)[number];

/** What the host says of the change's mergeability; the host's rules, not ours, decide at merge time. */
export type MergeState = "behind" | "blocked" | "clean" | "conflicting" | "draft" | "unknown" | "unstable";

export interface MergeStatus {
    autoMergeAllowed: boolean;
    autoMergeEnabled: boolean;
    /** The methods the repository's settings allow. */
    methods: MergeMethod[];
    state: MergeState;
}

export interface MergeRequest {
    /** The commit the person looked at: the host refuses the merge when the head has moved since. */
    headSha: string;
    method: MergeMethod;
}

export interface MergedPullRequest {
    sha: string | null;
}

// ─── Review ─────────────────────────────────────────────────────────────────

/** Which side of the diff a line number counts: the file before the change, or after it. */
export type DiffSide = "new" | "old";

export const REVIEW_VERDICTS = ["approve", "comment", "request_changes"] as const;

export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];

/** `changed`: viewed once, and the file has new changes since. */
export type ViewedState = "changed" | "unviewed" | "viewed";

/** A comment on one line (or a range ending on it) of a file in the diff. */
export interface LineComment {
    body: string;
    line: number;
    path: string;
    side: DiffSide;
    /** The first line of a range; `null` for a comment on a single line. */
    startLine: number | null;
}

/** One review as the host takes it: every comment, the verdict and the commit the lines refer to. */
export interface ReviewSubmission {
    body: string;
    comments: LineComment[];
    commitId: string;
    verdict: ReviewVerdict;
}

export interface SubmittedReview {
    id: string;
    url: string | null;
}

export interface ThreadComment {
    authorLogin: string;
    body: string;
    createdAt: number;
    /** The host's id for the comment: the one a reply addresses. */
    id: string;
}

export interface ReviewThread {
    canResolve: boolean;
    canUnresolve: boolean;
    comments: ThreadComment[];
    id: string;
    isOutdated: boolean;
    isResolved: boolean;
    line: number | null;
    path: string;
    side: DiffSide;
    startLine: number | null;
}

/** A page of a list that pages by cursor; `endCursor` is the host's opaque token for the next one. */
export interface CursorPage<T> {
    endCursor: string | null;
    hasMore: boolean;
    items: T[];
}

export interface ViewedFile {
    path: string;
    state: ViewedState;
}

/** What a UI needs to word and gate a host without naming it. */
export interface HostView {
    capabilities: HostCapabilityReport;
    /** The connector the user signs in with. */
    connectorSlug: string;
    label: string;
    /** The ceilings the host puts on a list; past them a count of what was left out is shown instead. */
    limits: { commits: number; files: number };
    /** The host's word for the change: "pull request", "merge request". */
    requestNoun: "merge request" | "pull request";
}
