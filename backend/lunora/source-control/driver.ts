/**
 * One driver per Git host, behind one interface. A driver turns the host's API
 * into the host-neutral shapes of `types.ts`, and declares what it can do in a
 * capability report. S1 is the read half; writes arrive with the slices that
 * declare them.
 *
 * The caller hands a driver a `HostRequest` bound to the host's origin, so a
 * driver cannot send the token anywhere else.
 */
import type { HostKind } from "./identity";
import type { HostRequest } from "./origin-fetch";
import type { CheckSummary, CommitPage, FilePage, HostView, InboxPage, InboxSection, PullRequestDetail, PullRequestRef } from "./types";

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
    /** What a UI needs to word and gate this host, without naming it. */
    readonly view: HostView;
    /** The web origin: a link a host returns is kept only when it starts here. */
    readonly webOrigin: string;
}
