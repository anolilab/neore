/**
 * One driver per Git host, behind one interface. A driver turns the host's API
 * into the host-neutral shapes of `types.ts`, and declares what it can do in a
 * capability report. Every write is one the user asked for; a driver never
 * writes on its own.
 *
 * The caller hands a driver a `HostRequest` bound to the host's origin, so a
 * driver cannot send the token anywhere else.
 */
import type { HostKind } from "./identity";
import type { HostRequest } from "./origin-fetch";
import type {
    CheckSummary,
    CommitPage,
    CursorPage,
    FilePage,
    HostView,
    InboxPage,
    InboxSection,
    MergedPullRequest,
    MergeMethod,
    MergeRequest,
    MergeStatus,
    PullRequestDetail,
    PullRequestRef,
    ReviewSubmission,
    ReviewThread,
    SubmittedReview,
    ViewedFile,
} from "./types";

/** The one write a coding agent asks a host for: a pull request for a branch that is already pushed. */
export interface CreatePullRequestInput {
    base: string;
    body: string;
    head: string;
    /** `owner/name`: the host's own way of naming a repository. */
    repository: string;
    title: string;
}

export interface CreatedPullRequest {
    /** The host's web page for the pull request it opened. */
    url: string;
}

export interface HostDriver {
    /** The host's API origin: the only place a token for this driver is sent. */
    readonly apiOrigin: string;
    /**
     * Opens a pull request for an already-pushed branch, and answers its web page.
     * Optional: a driver whose host cannot open one leaves it undeclared, and
     * `pullRequest.create` reads as unsupported.
     */
    createPullRequest?: (request: HostRequest, input: CreatePullRequestInput) => Promise<CreatedPullRequest>;
    getMergeStatus: (request: HostRequest, ref: PullRequestRef) => Promise<MergeStatus>;
    getPullRequest: (request: HostRequest, ref: PullRequestRef) => Promise<PullRequestDetail>;
    /** The request headers the host's API wants, besides the token. */
    readonly headers: Record<string, string>;
    readonly kind: HostKind;
    listChecks: (request: HostRequest, ref: PullRequestRef, headSha: string) => Promise<CheckSummary>;
    listCommits: (request: HostRequest, ref: PullRequestRef, page: number) => Promise<CommitPage>;
    listFiles: (request: HostRequest, ref: PullRequestRef, page: number) => Promise<FilePage>;
    listInbox: (request: HostRequest, section: InboxSection, page: number) => Promise<InboxPage>;
    /** The review conversation: threads of line comments, with their replies. */
    listThreads: (request: HostRequest, ref: PullRequestRef, after: string | null) => Promise<CursorPage<ReviewThread>>;
    /** Which files the reviewer has marked viewed on the host. */
    listViewed: (request: HostRequest, ref: PullRequestRef, after: string | null) => Promise<CursorPage<ViewedFile>>;
    /** Merges now, in ONE host call that names the head the person saw; the host's rules may refuse it. */
    mergePullRequest: (request: HostRequest, ref: PullRequestRef, merge: MergeRequest) => Promise<MergedPullRequest>;
    /** Posts a reply to the thread `commentId` belongs to, at once. */
    replyToThread: (request: HostRequest, ref: PullRequestRef, commentId: string, body: string) => Promise<{ id: string }>;
    /** Re-runs the narrowest scope the host offers for one check: a single job, not its whole workflow. */
    rerunCheck: (request: HostRequest, ref: PullRequestRef, checkId: string) => Promise<void>;
    /** Turns auto-merge on (merging `headSha` with `method` once the host's rules are met) or off. */
    setAutoMerge: (request: HostRequest, ref: PullRequestRef, enabled: boolean, method: MergeMethod, headSha: string) => Promise<void>;
    setThreadResolved: (request: HostRequest, threadId: string, resolved: boolean) => Promise<void>;
    setViewed: (request: HostRequest, ref: PullRequestRef, path: string, viewed: boolean) => Promise<void>;
    /** Posts the whole review in ONE host call, and returns it only when the host confirmed it. */
    submitReview: (request: HostRequest, ref: PullRequestRef, submission: ReviewSubmission) => Promise<SubmittedReview>;
    /** What a UI needs to word and gate this host, without naming it. */
    readonly view: HostView;
    /** The web origin: a link a host returns is kept only when it starts here. */
    readonly webOrigin: string;
}
