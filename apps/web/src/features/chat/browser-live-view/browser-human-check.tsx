/**
 * BrowserHumanCheck - the "Needs you" card in the chat, in place of a browser call's result when the agent's browser
 * reached a page only a person can clear (a human verification, a sign-in it cannot pass) and the person was asked
 * (`backend/lunora/browser/human-check.ts`). It names the site, shows what the browser sees, and takes control through
 * the live view card above the composer, which owns the lease; the agent gets the browser back on Hand back or after
 * the person stops using it. The person can also answer the ask once, Done or Decline
 * (`backend/lunora/browser/human-check-card.ts`): the agent hears it at its next look or while it waits for the answer.
 */
import { useLingui } from "@lingui/react/macro";
import type { Id } from "@neore/backend/dataModel";
import type { ToolPart } from "@neore/chat-ui/types";
import { toolImageSource } from "@neore/chat-ui/utils/tool-image-source";
import { Button } from "@neore/ui/components/button";
import { skipToken, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ShieldAlert } from "lucide-react";
import type { FC, FocusEvent } from "react";
import { use, useEffect, useEffectEvent, useId, useRef, useState } from "react";

import { useAuthSession } from "@/features/auth/hooks/use-auth-session";
import type { AccessAnswer, AccessMemory } from "@/features/chat/browser-live-view/card-access";
import { cardAccess, sameMemory, upcomingGrantEnd } from "@/features/chat/browser-live-view/card-access";
import { BrowserLiveViewHereContext, requestBrowserControl } from "@/features/chat/browser-live-view/control-request";
import {
    atGrantRevision,
    freshRead,
    readPastRecovery,
    useGrantRevision,
    useNewestRead,
    useReadOnRecovery,
} from "@/features/chat/browser-live-view/newest-read";
import { usePassed, useStatusSkew } from "@/features/chat/browser-live-view/status-clock";
import { useChatThreadIdentity } from "@/features/chat/core/context/chat-context-hooks";
import { useCRPC } from "@/lib/lunora/crpc";

/**
 * The host of `url` as the backend names a check's site (`backend/lunora/lib/url-host.ts#urlHost`, mirrored here, as the
 * web app takes only types from the backend): lower case, without trailing dots, so a check at `shop.example./` is still
 * on its site `shop.example`; `undefined` when it has none.
 */
const hostOf = (url: string | undefined): string | undefined => {
    if (url === undefined) {
        return undefined;
    }

    let hostname: string;

    try {
        ({ hostname } = new URL(url));
    } catch {
        return undefined;
    }

    let end = hostname.length;

    while (end > 0 && hostname[end - 1] === ".") {
        end -= 1;
    }

    return hostname.slice(0, end).toLowerCase();
};

/**
 * The ring of an element the card moves focus to when an answer button goes: on `:focus`, not `:focus-visible`, which
 * not every browser applies to focus a script moved.
 */
const MOVED_FOCUS = "rounded-sm outline-none focus:outline-2 focus:outline-solid focus:outline-offset-2 focus:outline-amber-700 dark:focus:outline-amber-400";

interface HumanCheckOutput {
    /**
     * `browserId`: the browser the ask was about (`getThreadBrowser`'s name for it); `checkId`: the ask the card answers,
     * `run` the reply that asked, which with `site` is the chat's key for it.
     */
    humanCheck?: { browserId?: string; checkId?: string; run?: string; site?: string };
    screenshot?: string;
    screenshotFormat?: string;
    screenshotUrl?: string;
    title?: string;
    url?: string;
}

type StatusAnswer = { accessUntil?: number; kind: "none" | "running"; now: number } | { kind: "denied"; now: number };
type AskAnswer =
    | { accessUntil?: number; canResolve: boolean; kind: "found"; now: number }
    | { accessUntil?: number; kind: "elsewhere"; now: number }
    | { kind: "none"; now: number };

/** A status answer as the access rule reads it (`card-access.ts`): `denied` says the caller does not read the chat. */
const statusAccess = (answer: StatusAnswer | undefined): AccessAnswer | undefined => {
    if (answer === undefined) {
        return undefined;
    }

    return answer.kind === "denied"
        ? { now: answer.now, reads: false }
        : { ...(answer.accessUntil !== undefined && { accessUntil: answer.accessUntil }), now: answer.now, reads: true };
};

/** An ask's answer as the access rule reads it: `none` says the caller does not read the chat; only `found` may answer. */
const askAccess = (answer: AskAnswer | undefined): AccessAnswer | undefined => {
    if (answer === undefined) {
        return undefined;
    }

    if (answer.kind === "none") {
        return { now: answer.now, reads: false };
    }

    return {
        ...(answer.accessUntil !== undefined && { accessUntil: answer.accessUntil }),
        ...(answer.kind === "found" && { canResolve: answer.canResolve }),
        now: answer.now,
        reads: true,
    };
};

interface HumanCheckCardProps {
    liveViewHere?: boolean;
    part: ToolPart;
    threadId: string | undefined;
}

const HumanCheckCardBody: FC<HumanCheckCardProps> = ({ liveViewHere = true, part, threadId }) => {
    const { t } = useLingui();
    const crpc = useCRPC();
    const queryClient = useQueryClient();
    const headingId = useId();
    const output = (part.output ?? {}) as HumanCheckOutput;
    const askedSite = output.humanCheck?.site || undefined;
    const statusArgs = threadId ? { threadId: threadId as Id<"threads"> } : skipToken;
    // The same live status the live view card reads: one subscription for both.
    const statusOptions = crpc.browser.live_view.getThreadBrowser.queryOptions(statusArgs);
    const status = useQuery(statusOptions);
    // The ask's own answer: given once, by whoever may control the browser; an older result names no ask to answer.
    const checkId = output.humanCheck?.checkId;
    // The site and reply too: the server reads the chat's own ask by them, never by id (another chat's row). A result
    // from before asks carried their reply names none: its card reads no ask and offers no answer.
    const checkSite = output.humanCheck?.site;
    const checkRun = output.humanCheck?.run;
    const checkArgs =
        checkId && threadId && checkSite !== undefined && checkRun !== undefined
            ? { checkId: checkId as Id<"browserHumanChecks">, run: checkRun, site: checkSite, threadId: threadId as Id<"threads"> }
            : skipToken;
    // Set once the ask can change no more (answered, expired, or of another chat): the card then drops its live subscription
    // and keeps the answer it has, so a long chat's past cards hold none of the socket's few and the open ask keeps its own.
    const [settled, setSettled] = useState(false);
    const checkOptions = crpc.browser.human_check_card.getHumanCheck.queryOptions(checkArgs);
    const check = useQuery({ ...checkOptions, enabled: !settled });
    // The ask is not settled and has been read: it answered open, or that the caller does not read it (a grant that ended,
    // a renewal one copy has not seen yet), or its read failed. Set below, from the answer the reads made here give; a
    // card that has not heard from its ask yet waits for the live read, so a long chat's settled cards read none on mount.
    const [askOpen, setAskOpen] = useState(false);
    // What the card keeps of its reads' word on the caller's access (`card-access.ts`): every answer of both reads, live
    // and one-shot, counts, so neither read's later answer undoes the other's denial.
    const [accessMemory, setAccessMemory] = useState<AccessMemory>({});
    // A read is behind the other (`cardAccess`): while it is, a settled ask's read runs on focus and reconnect too, so a
    // failed read at the moment it fell behind is not the last; it stops once both reads affirm again.
    const [readBehind, setReadBehind] = useState(false);
    // Every answer the ask's reads hold saw an older grant revision than one seen since (a renewal or a change, which
    // pushes the ask nothing): set below. The ask is then read again past its subscription, settled or not, so the card
    // shows its answer at the grant the caller has now rather than none.
    const [askBehindGrant, setAskBehindGrant] = useState(false);
    // Once access ended or was denied, or a grant may end, the reads are also made past their subscriptions, when the
    // card hides or shows, when one read is behind the other, and when the window regains focus: a renewed grant pushes
    // nothing, so it shows only so. The status's read is one for the whole chat (the same key on every card); the ask's
    // is the card's own, so it runs on its own (on mount and focus) only while the ask is open: a long chat's past cards
    // read theirs again only when that can change what they show, on hiding while open or when the ask is the read behind.
    const liveAnswers = [statusAccess(status.data), askAccess(check.data)];
    const freshWanted =
        accessMemory.end !== undefined ||
        liveAnswers.some((answer: AccessAnswer | undefined) => answer !== undefined && (!answer.reads || answer.accessUntil !== undefined));
    const statusAgainOptions = freshRead(
        crpc.browser.live_view.getThreadBrowser.queryOptions(statusArgs, { live: false }),
        freshWanted && statusArgs !== skipToken,
    );
    const statusAgain = useQuery(statusAgainOptions);
    const checkAgain = useQuery(
        freshRead(
            crpc.browser.human_check_card.getHumanCheck.queryOptions(checkArgs, { live: false }),
            ((freshWanted && (askOpen || readBehind)) || askBehindGrant) && checkArgs !== skipToken,
        ),
    );
    // The grant revision both reads' answers name (the same grant): an answer that saw an older one than any seen in this
    // chat (a replica's read after a removal, on a later clock than the removal's push) counts as no answer, here and in
    // the access rule below.
    const revision = useGrantRevision(statusOptions.queryKey, [status.data, statusAgain.data, check.data, checkAgain.data]);
    const statusNow = atGrantRevision(status, revision);
    const statusAgainNow = atGrantRevision(statusAgain, revision);
    const checkNow = atGrantRevision(check, revision);
    const checkAgainNow = atGrantRevision(checkAgain, revision);
    const askDropped = (check.data !== undefined || checkAgain.data !== undefined) && checkNow.data === undefined && checkAgainNow.data === undefined;

    if (askDropped !== askBehindGrant) {
        setAskBehindGrant(askDropped);
    }

    const browserRead = useNewestRead(statusNow, statusAgainNow, statusOptions.queryKey);
    const statusFailed = browserRead.failed;
    // Every answer carries the server's clock; one without a browser (none running, or none the caller may see) is `null`.
    const browserAnswer = browserRead.data;
    const browser = browserAnswer?.kind === "running" ? browserAnswer : browserAnswer && null;
    // A control lease whose end passed (on the server's clock) is over, though no new status says so yet: the live view
    // card reads it the same way, so both offer Take control again at once.
    const skew = useStatusSkew(browserAnswer?.now, browserRead.at);
    const controlEnded = usePassed(browser?.control === undefined ? undefined : browser.control.until - skew);
    const control = controlEnded ? undefined : browser?.control;
    // The status answer no live view card answered on (its browser and server time): once a new one arrives, as when the
    // agent acts on that browser again and its live view card comes back, the button does too.
    const answerKey = browser === undefined || browser === null ? undefined : `${browser.browserId}@${String(browser.now)}`;
    const [missedAnswer, setMissedAnswer] = useState<string | undefined>(undefined);
    const missed = answerKey !== undefined && missedAnswer === answerKey;
    // The thread's browser now is not the one asked about (a later reply opened another), or it moved on to another site
    // while nobody has control: taking it over from this card would hand the agent's current work to the person.
    const earlierBrowser = browser !== undefined && browser !== null && output.humanCheck?.browserId !== browser.browserId;
    const movedOn = browser !== undefined && browser !== null && askedSite !== undefined && control === undefined && hostOf(browser.currentUrl) !== askedSite;
    const checkRead = useNewestRead(checkNow, checkAgainNow, checkOptions.queryKey);
    const checkFailed = checkRead.failed;
    const checkAnswer = checkRead.data;
    const checkData = checkAnswer?.kind === "found" ? checkAnswer : checkAnswer && null;
    const resolve = useMutation(crpc.browser.human_check_card.resolveHumanCheck.mutationOptions());
    // An unanswered ask closes at `expiresAt` on the server's clock, which its own answer carries (`now`).
    const checkSkew = useStatusSkew(checkAnswer?.now, checkRead.at);
    const accessReads = {
        ask: checkArgs === skipToken ? undefined : [askAccess(checkNow.data), askAccess(checkAgainNow.data)],
        memory: accessMemory,
        status: statusArgs === skipToken ? undefined : [statusAccess(statusNow.data), statusAccess(statusAgainNow.data)],
    };
    // A grant ends (`accessUntil`) on the server's clock, and nothing re-runs a live query when only the clock moves: the
    // card's timer waits for it on the larger of the two reads' skews, the earlier deadline here.
    const skews = [...(browserAnswer === undefined ? [] : [skew]), ...(checkAnswer === undefined ? [] : [checkSkew])];
    const grantSkew = skews.length === 0 ? 0 : Math.max(...skews);
    const nextGrantEnd = upcomingGrantEnd(accessReads);
    const grantPassed = usePassed(nextGrantEnd === undefined ? undefined : nextGrantEnd - grantSkew);
    const access = cardAccess({ ...accessReads, ...(grantPassed && nextGrantEnd !== undefined && { serverPast: nextGrantEnd }) });

    if (!sameMemory(access.memory, accessMemory)) {
        setAccessMemory(access.memory);
    }

    if (access.behind !== readBehind) {
        setReadBehind(access.behind);
    }

    // `hidden`: a read said access ended or was denied. `shown`: on top of that, every read the card needs has answered;
    // until then the card shows nothing of the site, as a cached card may be on screen for someone who no longer reads it.
    const hidden = access.hidden === "ended" || access.hidden === "unreadable";
    const shown = access.hidden === undefined;
    const readsBefore = useRef({ behind: access.behind, hidden });
    // The status's read joins one already out (`cancelRefetch: false`): every card of the chat asks at the same moment (a
    // grant's end, a subscription back), and one read answers them all. A skipped query has nothing to read: its refetch
    // would fail. `after`: the end the card reads past. The read joined may have been sent before it, and its answer, from
    // then, cannot show the card again: one answering at or before that end is followed by one new read once it settled.
    const readStatusAgain = (after?: number): void => {
        if (statusArgs === skipToken) {
            return;
        }

        statusAgain
            .refetch({ cancelRefetch: false })
            .then((result: { data?: StatusAnswer }) => {
                if (after !== undefined && (result.data === undefined || result.data.now <= after)) {
                    return statusAgain.refetch({ cancelRefetch: false });
                }

                return undefined;
            })
            .catch(() => undefined);
    };
    const readAskAgain = (): void => {
        if (checkArgs !== skipToken) {
            checkAgain.refetch().catch(() => undefined);
        }
    };
    // `behind`: a read is behind the other, so both are read, as only that can show the card again; else the ask only
    // while it is open.
    const readAgain = useEffectEvent((behind: boolean): void => {
        readStatusAgain(hidden ? access.memory.end : undefined);

        if (behind || askOpen) {
            readAskAgain();
        }
    });

    const readDroppedAsk = useEffectEvent((): void => {
        readAskAgain();
    });

    // Once per drop: a read that answers at the older revision again (a copy of the grant behind) changes nothing, so it
    // does not loop; focus reads it again while it stays behind.
    useEffect(() => {
        if (askBehindGrant) {
            readDroppedAsk();
        }
    }, [askBehindGrant]);

    useEffect(() => {
        const before = readsBefore.current;

        readsBefore.current = { behind: access.behind, hidden };

        // Each change of what shows reads again once, the ask only while it is open; a read found behind the other reads
        // both, as only that can show the card again. A read that answers a denial again changes neither, so the card
        // reads again only on a new answer (two copies of the grant that disagree flip it once per answer, until they agree).
        const behind = access.behind && !before.behind;

        if (behind || before.hidden !== hidden) {
            readAgain(behind);
        }
    }, [access.behind, hidden]);

    // A subscription that comes back answers its last push again, which clears no failure (`useNewestRead`): the card
    // reads once past it, so an answer newer than the failure shows without Try again. The ask only while it is open.
    useReadOnRecovery(status, statusOptions.queryKey, statusFailed, () => {
        if (statusArgs !== skipToken) {
            readPastRecovery(queryClient, statusAgainOptions.queryKey, statusAgain);
        }
    });
    useReadOnRecovery(check, checkOptions.queryKey, checkFailed && !settled, readAskAgain);

    const site = shown ? askedSite : undefined;
    const lapsedNow = usePassed(checkData?.status === "open" ? checkData.expiresAt - checkSkew : undefined);
    // Once shown, a lapse stands: a later open answer delivered late moves the deadline on this device past it, but the
    // server takes no answer after the ask's end.
    const [lapseSeen, setLapseSeen] = useState(false);

    if (lapsedNow && !lapseSeen) {
        setLapseSeen(true);
    }

    const lapsed = lapsedNow || lapseSeen;
    // The answer this card saved stands over a lapse its timer saw before the new read came.
    const answer = resolve.data?.status ?? (lapsed && checkData?.status === "open" ? "expired" : checkData?.status);
    const answered = answer !== undefined && answer !== "open";

    // Only on the server's word or this tab's saved answer, never a lapse on this device's clock: an answer given elsewhere
    // before the real expiry still reaches the card.
    const finalAnswer = resolve.data?.status ?? checkData?.status;

    const settles = (finalAnswer !== undefined && finalAnswer !== "open") || checkAnswer?.kind === "elsewhere";

    // A lapse this card saw also lets go of the live read: the server takes no answer after the ask's end, so nothing it
    // pushes later can open it again. The card shows it closed either way; the one read below brings an answer given
    // before the end, elsewhere, that the subscription had not pushed yet.
    if (!settled && (settles || lapseSeen)) {
        setSettled(true);
    }

    const readLapsedAsk = useEffectEvent((): void => {
        if (!settles) {
            readAskAgain();
        }
    });

    useEffect(() => {
        if (lapseSeen) {
            readLapsedAsk();
        }
    }, [lapseSeen]);

    const openNow = !settled && !settles && (checkAnswer !== undefined || checkFailed);

    if (openNow !== askOpen) {
        setAskOpen(openNow);
    }

    // A failed read of the ask may keep an earlier open answer: it no longer says the ask is open.
    const canAnswer = access.mayAnswer && !checkFailed && !answered && checkArgs !== skipToken;
    // Only a browser read now as the one asked about has a page to mark done: the person can still decline. One that
    // moved on to another site may be where the check led once cleared (a sign-in that redirects).
    const browserHere = browser !== undefined && browser !== null && !statusFailed && !earlierBrowser;
    const canMarkDone = canAnswer && browserHere;
    // An answer button that held focus goes (the answer was saved, here or elsewhere, the ask lapsed, the grant ended,
    // the browser went): focus moves to the status that says why, or to the card's heading when it says nothing. While
    // an answer saves, the buttons stay focusable (`aria-disabled`), so focus stays on the one pressed.
    const headingRef = useRef<HTMLHeadingElement>(null);
    const statusRef = useRef<HTMLParagraphElement>(null);
    const answerFocused = useRef(false);

    useEffect(() => {
        if (!answerFocused.current || (document.activeElement !== null && document.activeElement !== document.body)) {
            return;
        }

        answerFocused.current = false;
        // The card is where the button was: nothing to scroll to.
        (statusRef.current?.textContent ? statusRef.current : headingRef.current)?.focus({ preventScroll: true });
    }, [canAnswer, canMarkDone, resolve.isError]);

    const sendAnswer = (resolution: "declined" | "done"): void => {
        if (checkArgs === skipToken) {
            return;
        }

        resolve.mutate({ ...checkArgs, resolution });
    };
    const screenshot =
        shown && output.screenshotFormat
            ? toolImageSource({ inline: output.screenshot, mediaType: `image/${output.screenshotFormat}`, url: output.screenshotUrl })
            : undefined;

    // "You" only for the answer this card saved: one read from the ask may be another person's.
    const answeredHere = resolve.data?.changed === true;
    const answerNotes = {
        declined: answeredHere
            ? t`You declined this check. The agent will not use this site again in this reply.`
            : t`This check was declined. The agent will not use this site again in this reply.`,
        done: answeredHere
            ? t`You marked this check done. The agent looks at the page again before it goes on.`
            : t`This check was marked done. The agent looks at the page again before it goes on.`,
        expired: t`This check is no longer open. Ask the agent to try again if it is still needed.`,
    };

    let browserState: string | undefined;

    if (statusFailed) {
        // The status could not be read: the browser may still be running, so the card says so and can ask again, never
        // that it closed.
        browserState = t`Whether the browser is still open could not be checked.`;
    } else if (browser === null) {
        // The provider closes a browser about a minute after its last action, and an open ask does not keep it (that would
        // be paid browser time while nobody looks): a late reader is told so, and a retry in a new reply (a steer keeps the
        // reply's one ask per site) opens a new browser.
        browserState = t`The browser has closed, so this check can no longer be cleared here. Once the agent's reply has finished, ask it to try again: it opens a new browser and asks you again if the check still shows.`;
    } else if (earlierBrowser) {
        browserState = t`This check was for an earlier browser, which the agent no longer uses.`;
    } else if (movedOn) {
        browserState = canAnswer
            ? t`The browser has since moved on from ${site}. Mark the check done if you cleared it, or decline it.`
            : t`The browser has since moved on from ${site}, so this check is no longer open.`;
    } else if (missed) {
        // No live view card answered: the browser went idle (its card is gone) though the status still lists it.
        browserState = t`The browser cannot be taken over right now. Ask the agent to look at the page again if it is still needed.`;
    } else if (control?.byYou === true) {
        browserState = t`You have control. Clear the check in the live view, then hand the browser back.`;
    } else if (control !== undefined) {
        browserState = t`Someone else has control of this browser.`;
    } else if (browser?.canControl === false) {
        browserState = t`Only someone who can write in this chat can take control of the browser.`;
    } else if (!liveViewHere && browser !== undefined) {
        // A comparison column has no live view card: an unanswered request would not mean the browser closed.
        browserState = t`Open this model's chat on its own to take control of its browser.`;
    }

    let state = browserState;

    if (access.hidden === "ended") {
        state = t`Your access to this chat has ended.`;
    } else if (access.hidden === "unreadable") {
        state = t`This check can no longer be read here.`;
    } else if (!shown) {
        // Nothing of the site before the reads answer: a failed one says so (Try again stays), else the card waits.
        if (statusFailed) {
            state = browserState;
        } else if (checkFailed) {
            state = t`Whether this check is still open could not be checked.`;
        } else {
            state = t`Loading this check…`;
        }
    } else if (answered) {
        state = answerNotes[answer];
    } else if (resolve.isPending && canAnswer) {
        // The answer buttons wait on the save: the status region says why, so a screen reader is not left on a dead button.
        state = t`Saving your answer…`;
    } else if (resolve.isError && canAnswer) {
        state = t`Your answer could not be saved. Try again.`;
    } else if (checkFailed) {
        state = t`Whether this check is still open could not be checked.`;
    } else if (checkAnswer?.kind === "elsewhere") {
        state = browserState ?? t`This check cannot be answered in this chat.`;
    }

    // A failed save or read of the ask leaves the browser as it was: Take control stays.
    const canAsk = browser !== undefined && browser !== null && browserState === undefined && shown && !answered && threadId !== undefined;
    let hint: string | undefined;

    if (canAsk) {
        hint = canMarkDone
            ? t`Take control, clear it and hand the browser back, then mark it done. Or decline if you will not.`
            : t`Take control, clear it, then hand the browser back.`;
    } else if (canMarkDone && control !== undefined) {
        hint = t`Once the check is cleared, mark it done. Or decline if you will not.`;
    }

    return (
        <section
            aria-labelledby={headingId}
            className="mb-4 overflow-hidden rounded-lg border border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-950/40"
        >
            <div className="flex flex-wrap items-start gap-2 px-3 py-2">
                <ShieldAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-amber-700 dark:text-amber-400" />
                <div className="min-w-0 flex-1">
                    <h3
                        className={`text-sm font-medium text-amber-900 dark:text-amber-200 ${MOVED_FOCUS}`}
                        id={headingId}
                        ref={headingRef}
                        tabIndex={-1}
                    >{t`Needs you`}</h3>
                    <p className="text-xs text-amber-900 dark:text-amber-200">
                        {site === undefined
                            ? t`The agent's browser reached a page only a person can clear. The agent waits and will not try to get around it.`
                            : t`The agent's browser reached a page on ${site} only a person can clear. The agent waits and will not try to get around it.`}
                    </p>
                    {hint !== undefined && <p className="text-xs text-amber-800 dark:text-amber-300">{hint}</p>}
                    {/* Mounted throughout, so a screen reader announces the text when it changes. */}
                    <p className={`mt-1 text-xs text-amber-800 empty:mt-0 dark:text-amber-300 ${MOVED_FOCUS}`} ref={statusRef} role="status" tabIndex={-1}>
                        {state}
                    </p>
                </div>
                {canAnswer && (
                    <div
                        className="flex flex-wrap gap-2"
                        onBlur={(event: FocusEvent<HTMLDivElement>) => {
                            // Focus moved on to another element, or to none in this window while the button stays (a click on
                            // the page's text): no move is owed. A button removed, or the window left (the answer may come
                            // from another tab), leaves the move to the effect.
                            const left = event.target;

                            if (event.relatedTarget === null) {
                                queueMicrotask(() => {
                                    if (left.isConnected && document.hasFocus()) {
                                        answerFocused.current = false;
                                    }
                                });
                            } else {
                                answerFocused.current = false;
                            }
                        }}
                        onFocus={() => {
                            answerFocused.current = true;
                        }}
                    >
                        {canMarkDone && (
                            <Button
                                className="aria-disabled:opacity-50 any-pointer-coarse:min-h-11"
                                disabled={resolve.isPending}
                                focusableWhenDisabled
                                onClick={() => sendAnswer("done")}
                                size="sm"
                                type="button"
                                variant="outline"
                            >
                                {t`Mark done`}
                            </Button>
                        )}
                        <Button
                            className="aria-disabled:opacity-50 any-pointer-coarse:min-h-11"
                            disabled={resolve.isPending}
                            focusableWhenDisabled
                            onClick={() => sendAnswer("declined")}
                            size="sm"
                            type="button"
                            variant="ghost"
                        >
                            {t`Decline`}
                        </Button>
                    </div>
                )}
                {!hidden && !answered && (statusFailed || checkFailed) && (
                    <Button
                        className="any-pointer-coarse:min-h-11"
                        disabled={status.isFetching || check.isFetching || statusAgain.isFetching || checkAgain.isFetching}
                        onClick={() => {
                            // A live query's refetch answers its last push again, which clears no failure: a failed read
                            // is also read past the subscription.
                            const reads = new Set([
                                ...[status, check, statusAgain, checkAgain].filter((read) => read.isError),
                                ...(statusFailed ? [statusAgain] : []),
                                ...(checkFailed ? [checkAgain] : []),
                            ]);

                            for (const query of reads) {
                                query.refetch().catch(() => undefined);
                            }
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
                        onClick={() => setMissedAnswer(requestBrowserControl(threadId) ? undefined : answerKey)}
                        size="sm"
                        type="button"
                    >
                        {t`Take control`}
                    </Button>
                )}
            </div>
            {shown &&
                (screenshot === undefined ? (
                    <p className="border-t border-amber-200 px-3 py-2 text-xs text-amber-800 dark:border-amber-800 dark:text-amber-300">
                        {/* Take control is offered only while the card can ask: an answered or settled ask has no button to point at. */}
                        {canAsk
                            ? t`No picture of the page could be taken. Take control to see it in the live view.`
                            : t`No picture of the page could be taken.`}
                    </p>
                ) : (
                    <img
                        alt={site === undefined ? t`What the agent's browser sees` : t`What the agent's browser sees on ${site}`}
                        className="ph-no-capture w-full border-t border-amber-200 dark:border-amber-800"
                        src={screenshot}
                    />
                ))}
        </section>
    );
};

/**
 * The card for the thread `threadId`; exported for stories and tests, which have no chat around it. `liveViewHere`:
 * whether the thread's live view card is on this page to take control through (see {@link BrowserLiveViewHereContext}).
 * Keyed by the signed-in account, the chat and the ask, so a card reused for another (an account or chat switch, a new
 * result) starts afresh: no answer, grant end or settled read of the last one carries over. An answer one account sent
 * that completes after a switch so never tells the next account it gave it.
 */
export const HumanCheckCard: FC<HumanCheckCardProps> = ({ liveViewHere, part, threadId }) => {
    const { data: session } = useAuthSession();
    const ask = ((part.output ?? {}) as HumanCheckOutput).humanCheck;
    const askKey = JSON.stringify([session?.user.id, threadId, ask?.site, ask?.run, ask?.checkId]);

    return <HumanCheckCardBody key={askKey} liveViewHere={liveViewHere} part={part} threadId={threadId} />;
};

const BrowserHumanCheck: FC<{ part: ToolPart }> = ({ part }) => {
    const { threadId } = useChatThreadIdentity();
    const liveViewHere = use(BrowserLiveViewHereContext);

    return <HumanCheckCard liveViewHere={liveViewHere} part={part} threadId={threadId} />;
};

export default BrowserHumanCheck;
