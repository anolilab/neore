import type { LunoraClient, ReturnOf, Unsubscribe } from "@lunora/client";
import { api } from "@neore/backend/api";
import type { Id } from "@neore/backend/dataModel";

/** The slice of the client this uses, so tests can fake it. */
export type BrowserClient = Pick<LunoraClient, "action" | "mutation" | "query" | "subscribe">;

export type BrowserStatus = ReturnOf<typeof api.browser.live_view.getThreadBrowser>;
export type BrowserFrame = ReturnOf<typeof api.browser.frame.readBrowserFrame>;
export type TakeAnswer = ReturnOf<typeof api.browser.live_view.takeControl>;
export type NavigateAnswer = ReturnOf<typeof api.browser.live_view.navigateInControl>;

const thread = (threadId: string): Id<"threads"> => threadId as Id<"threads">;

/** Live: the thread browser's status, again on every change (an agent action, a lease taken or ended). */
export const watchBrowserStatus = (
    client: BrowserClient,
    threadId: string,
    onStatus: (status: BrowserStatus) => void,
    onError: (message: string) => void,
): Unsubscribe =>
    client.subscribe(api.browser.live_view.getThreadBrowser, { threadId: thread(threadId) }, onStatus, { onError: (error) => onError(error.message) });

/** One read of the status, past the live subscription: a renewed grant pushes nothing to it. */
export const readBrowserStatus = async (client: BrowserClient, threadId: string): Promise<BrowserStatus> =>
    await client.query(api.browser.live_view.getThreadBrowser, { threadId: thread(threadId) });

export const readFrame = async (client: BrowserClient, threadId: string): Promise<BrowserFrame> =>
    await client.action(api.browser.frame.readBrowserFrame, { threadId: thread(threadId) });

/**
 * The phone never takes the lease over from another of the person's views (`exclusive`): it is refused (`held`) while
 * the web drives the browser. `renews`: the claim this phone held, so its own lease is not refused.
 */
export const takeBrowserControl = async (client: BrowserClient, threadId: string, renews?: string): Promise<TakeAnswer> =>
    await client.action(api.browser.live_view.takeControl, { exclusive: true, threadId: thread(threadId), ...renews !== undefined && { renews } });

// Mutations pass `onlineOnly`: a renewal or hand back held for later would act on a lease long over.
export const keepBrowserControl = async (client: BrowserClient, threadId: string, claim: string): Promise<{ until: number } | null> =>
    await client.mutation(api.browser.live_view.keepControl, { claim, threadId: thread(threadId) }, { onlineOnly: true });

export const handBackBrowser = async (client: BrowserClient, threadId: string, claim: string, reason: "handed_back" | "left"): Promise<boolean> =>
    await client.mutation(api.browser.live_view.handBack, { claim, reason, threadId: thread(threadId) }, { onlineOnly: true });

export const navigateBrowser = async (client: BrowserClient, threadId: string, claim: string, url: string): Promise<NavigateAnswer> =>
    await client.action(api.browser.live_view.navigateInControl, { claim, threadId: thread(threadId), url });
