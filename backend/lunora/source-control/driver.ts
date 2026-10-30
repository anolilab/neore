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
    PullRequestDetail,
    PullRequestRef,
    ReviewSubmission,
    ReviewThread,
    SubmittedReview,
    ViewedFile,
} from "./types";

export interface HostDriver {
    /** The host's API origin: the only place a token for this driver is sent. */
    readonly apiOrigin: string;
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
    /** Posts a reply to the thread `commentId` belongs to, at once. */
    replyToThread: (request: HostRequest, ref: PullRequestRef, commentId: string, body: string) => Promise<{ id: string }>;
    setThreadResolved: (request: HostRequest, threadId: string, resolved: boolean) => Promise<void>;
    setViewed: (request: HostRequest, ref: PullRequestRef, path: string, viewed: boolean) => Promise<void>;
    /** Posts the whole review in ONE host call, and returns it only when the host confirmed it. */
    submitReview: (request: HostRequest, ref: PullRequestRef, submission: ReviewSubmission) => Promise<SubmittedReview>;
    /** What a UI needs to word and gate this host, without naming it. */
    readonly view: HostView;
    /** The web origin: a link a host returns is kept only when it starts here. */
    readonly webOrigin: string;
}
