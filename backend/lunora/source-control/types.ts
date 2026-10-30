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
    name: string;
    state: CheckState;
    url: string | null;
}

export interface CheckSummary {
    checks: CheckRun[];
    /** How many the host reports; `checks` holds at most one bounded page of them. */
    total: number;
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
