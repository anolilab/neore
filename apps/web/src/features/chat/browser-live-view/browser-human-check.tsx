/**
 * BrowserHumanCheck - the "Needs you" card in the chat, in place of a browser call's result when the agent's browser
 * reached a page only a person can clear (a human verification, a sign-in it cannot pass) and the person was asked
 * (`backend/lunora/browser/human-check.ts`). It names the site, shows what the browser sees, and takes control through
 * the live view card above the composer, which owns the lease; the agent gets the browser back on Hand back or after
 * the person stops using it.
 */
import { useLingui } from "@lingui/react/macro";
import type { Id } from "@neore/backend/dataModel";
import type { ToolPart } from "@neore/chat-ui/types";
import { toolImageSource } from "@neore/chat-ui/utils/tool-image-source";
import { Button } from "@neore/ui/components/button";
import { skipToken, useQuery } from "@tanstack/react-query";
import { ShieldAlert } from "lucide-react";
import type { FC } from "react";
import { use, useId, useState } from "react";

import { BrowserLiveViewHereContext, requestBrowserControl } from "@/features/chat/browser-live-view/control-request";
import { useChatThreadIdentity } from "@/features/chat/core/context/chat-context-hooks";
import { useCRPC } from "@/lib/lunora/crpc";

interface HumanCheckOutput {
    humanCheck?: { site?: string };
    screenshot?: string;
    screenshotFormat?: string;
    screenshotUrl?: string;
    title?: string;
    url?: string;
}

/**
 * The card for the thread `threadId`; exported for stories and tests, which have no chat around it. `liveViewHere`:
 * whether the thread's live view card is on this page to take control through (see {@link BrowserLiveViewHereContext}).
 */
export const HumanCheckCard: FC<{ liveViewHere?: boolean; part: ToolPart; threadId: string | undefined }> = ({ liveViewHere = true, part, threadId }) => {
    const { t } = useLingui();
    const crpc = useCRPC();
    const headingId = useId();
    const output = (part.output ?? {}) as HumanCheckOutput;
    const site = output.humanCheck?.site || undefined;
    // The same live status the live view card reads: one subscription for both.
    const status = useQuery(crpc.browser.live_view.getThreadBrowser.queryOptions(threadId ? { threadId: threadId as Id<"threads"> } : skipToken));
    const browser = status.data;
    // The browser no live view card answered for: once it changes, the button comes back.
    const [missedBrowser, setMissedBrowser] = useState<string | undefined>(undefined);
    const missed = browser !== undefined && browser !== null && missedBrowser === browser.browserId;
    const screenshot = output.screenshotFormat
        ? toolImageSource({ inline: output.screenshot, mediaType: `image/${output.screenshotFormat}`, url: output.screenshotUrl })
        : undefined;

    let state: string | undefined;

    // The status could not be read: the browser may still be running, so the card says so and can ask again, never
    // that it closed.
    if (status.isError) {
        state = t`Whether the browser is still open could not be checked.`;
    } else if (browser === null) {
        state = t`The browser has closed. Ask the agent to open the page again if it is still needed.`;
    } else if (missed) {
        // No live view card answered: the browser went idle (its card is gone) though the status still lists it.
        state = t`The browser cannot be taken over right now. Ask the agent to look at the page again if it is still needed.`;
    } else if (browser?.control?.byYou === true) {
        state = t`You have control. Clear the check in the live view, then hand the browser back.`;
    } else if (browser?.control !== undefined) {
        state = t`Someone else has control of this browser.`;
    } else if (browser?.canControl === false) {
        state = t`Only someone who can write in this chat can take control of the browser.`;
    } else if (!liveViewHere && browser !== undefined) {
        // A comparison column has no live view card: an unanswered request would not mean the browser closed.
        state = t`Open this model's chat on its own to take control of its browser.`;
    }

    const canAsk = browser !== undefined && browser !== null && state === undefined && threadId !== undefined;

    return (
        <section
            aria-labelledby={headingId}
            className="mb-4 overflow-hidden rounded-lg border border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-950/40"
        >
            <div className="flex flex-wrap items-start gap-2 px-3 py-2">
                <ShieldAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-amber-700 dark:text-amber-400" />
                <div className="min-w-0 flex-1">
                    <h3 className="text-sm font-medium text-amber-900 dark:text-amber-200" id={headingId}>{t`Needs you`}</h3>
                    <p className="text-xs text-amber-900 dark:text-amber-200">
                        {site === undefined
                            ? t`The agent's browser reached a page only a person can clear. The agent waits and will not try to get around it.`
                            : t`The agent's browser reached a page on ${site} only a person can clear. The agent waits and will not try to get around it.`}
                    </p>
                    <p className="text-xs text-amber-800 dark:text-amber-300">{t`Take control, clear it, then hand the browser back.`}</p>
                    {/* Mounted throughout, so a screen reader announces the text when it changes. */}
                    <p className="mt-1 text-xs text-amber-800 empty:hidden dark:text-amber-300" role="status">
                        {state}
                    </p>
                </div>
                {status.isError && (
                    <Button
                        className="any-pointer-coarse:min-h-11"
                        disabled={status.isFetching}
                        onClick={() => {
                            status.refetch().catch(() => undefined);
                        }}
                        size="sm"
                        type="button"
                        variant="outline"
                    >
                        {t`Try again`}
                    </Button>
                )}
                {canAsk && (
                    <Button
                        className="any-pointer-coarse:min-h-11"
                        onClick={() => setMissedBrowser(requestBrowserControl(threadId) ? undefined : browser?.browserId)}
                        size="sm"
                        type="button"
                    >
                        {t`Take control`}
                    </Button>
                )}
            </div>
            {screenshot === undefined ? (
                <p className="border-t border-amber-200 px-3 py-2 text-xs text-amber-800 dark:border-amber-800 dark:text-amber-300">
                    {t`No picture of the page could be taken. Take control to see it in the live view.`}
                </p>
            ) : (
                <img
                    alt={site === undefined ? t`What the agent's browser sees` : t`What the agent's browser sees on ${site}`}
                    className="ph-no-capture w-full border-t border-amber-200 dark:border-amber-800"
                    src={screenshot}
                />
            )}
        </section>
    );
};

const BrowserHumanCheck: FC<{ part: ToolPart }> = ({ part }) => {
    const { threadId } = useChatThreadIdentity();
    const liveViewHere = use(BrowserLiveViewHereContext);

    return <HumanCheckCard liveViewHere={liveViewHere} part={part} threadId={threadId} />;
};

export default BrowserHumanCheck;
