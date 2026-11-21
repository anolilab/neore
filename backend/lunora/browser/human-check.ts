/**
 * A page only a person can clear (a human-verification challenge, a bot-check interstitial, a sign-in wall the agent
 * reports): the agent waits once for it to clear on its own, then asks the person once per site per reply, and after
 * they hand the browser back it is told whether the page is clear. Detection reads only what the renderer returns
 * (title, URL, extracted text): deterministic, no model call. Pure, so each step is tested without the provider.
 */

/** How long the agent waits for an interstitial to clear on its own before it asks the person. */
export const HUMAN_CHECK_WAIT_MS = 8000;

/**
 * How long after an ask a hand back in a later reply still counts as the person clearing it: time to see the card,
 * take control and come back. An older ask on the site is not about the page they hand back.
 */
export const HUMAN_CHECK_HAND_BACK_WINDOW_MS = 60 * 60_000;

/**
 * The most renderer calls the ladder makes of its own in one tool call: at worst a read after a navigation that came
 * back handed back but failed, the hand back's own read, which lands on another site's check, the look after that
 * check's wait and the card's screenshot. They are not charged to the user's browser rate limit
 * (`browser/action:<tier>`), as the agent never asked for them, so this fixed cap bounds them instead: every tool call
 * that reaches the ladder ran one charged action first.
 */
export const HUMAN_CHECK_LOOK_BUDGET = 4;

/** Extracted text longer than this is a real page that merely mentions a check, never the check itself. */
const SHORT_PAGE_CHARS = 3000;

/** Whole-title patterns of challenge and interstitial pages (trimmed, any case): never a prefix a real page could share. */
const TITLE_MARKERS: ReadonlyArray<RegExp> = [
    /^just a moment(?:\.{3}|…)?$/iu,
    /^attention required!?(?:\s*\|.*)?$/iu,
    /^(?:please )?verify(?:ing)? (?:that )?you are (?:a )?human\.?$/iu,
    /^are you a (?:human|robot)\??$/iu,
    /^(?:human|bot) (?:verification|check)$/iu,
    /^security check$/iu,
    /^checking your browser(?: before accessing\b.*|\.{3}|…)?$/iu,
    /^one more step$/iu,
    /^captcha$/iu,
];

/** URLs only a challenge page has: its own path, or the token it adds to the address. */
const URL_MARKERS: ReadonlyArray<RegExp> = [/\/cdn-cgi\/challenge-platform\//iu, /[?&]__cf_chl_[a-z_]*=/iu];

/** Phrases only a challenge shows: one on a short whole page is enough. */
const CONTENT_MARKERS: ReadonlyArray<RegExp> = [
    /verify(?:ing)? (?:that )?you are (?:a )?human/iu,
    /checking (?:if the site connection is secure|your browser before accessing)/iu,
    /enable javascript and cookies to continue/iu,
    /complete the security check/iu,
];

/**
 * Phrases a challenge shows that an ordinary short page can too ("press and hold the power button", a FAQ quoting
 * "I'm not a robot"): they count only beside a word of {@link CHALLENGE_WORDS} that the phrase itself does not carry.
 */
const GENERIC_CONTENT_MARKERS: ReadonlyArray<RegExp> = [/press (?:and|&) hold/iu, /i['’]?m not a robot/iu];

/** The second signal a generic phrase needs (not "robot", which one of them names). */
const CHALLENGE_WORDS = /\b(?:captcha|recaptcha|hcaptcha|human|bots?|verification)\b/iu;

const showsChallengeText = (content: string): boolean =>
    CONTENT_MARKERS.some((marker) => marker.test(content)) || (GENERIC_CONTENT_MARKERS.some((marker) => marker.test(content)) && CHALLENGE_WORDS.test(content));

/** What a renderer result carries that detection reads. */
export interface PageSignals {
    content?: string;
    title?: string;
    url?: string;
}

/** Why a page reads as a check: a whole-title match, a challenge URL, or a short page's wording. */
export type HumanCheckMarker = "content" | "title" | "url";

/**
 * The marker a page shows, or `undefined` when nothing says a person is needed. `readContent`: `content` is the whole
 * page's text (an extract with no selector); a selected element's text is always short, so it is never read.
 */
export const detectHumanCheck = ({ content, title, url }: PageSignals, readContent = false): HumanCheckMarker | undefined => {
    const trimmed = title?.trim();

    if (trimmed !== undefined && TITLE_MARKERS.some((marker) => marker.test(trimmed))) {
        return "title";
    }

    if (url !== undefined && URL_MARKERS.some((marker) => marker.test(url))) {
        return "url";
    }

    if (readContent && content !== undefined && content.length <= SHORT_PAGE_CHARS && showsChallengeText(content)) {
        return "content";
    }

    return undefined;
};

/** The site a check is asked for once: the page's host, lower case; `""` when the page has no readable URL. */
export const humanCheckSite = (url: string | undefined): string => {
    if (url === undefined) {
        return "";
    }

    try {
        return new URL(url).hostname.toLowerCase();
    } catch {
        return "";
    }
};

/** What the browser tool tells the agent at each step; never to solve or bypass the check itself. */
export const humanCheckMessages = {
    afterReportedHandBack: (site: string): string =>
        `The person handed the browser back after you asked them about ${siteName(site)}. Check whether what you asked them for is done before you act.`,
    alreadyAsked: (site: string): string =>
        `${siteName(site)} still shows a check that needs a person. The person was already asked to clear it during this task, so they are not asked again. Do not try to solve or get around it: move on, or reach what you need another way.`,
    asked: (site: string): string =>
        `${siteName(site)} shows a check that needs a person (a human verification or a sign-in you cannot pass), and it did not clear on its own. The person was asked in the chat to clear it in the live view. Do not try to solve or get around it, and do not use the browser on this site until they hand it back: tell them what you are waiting for, or carry on with other work.`,
    clearedAfterHandBack: (site: string): string => `The check on ${siteName(site)} no longer shows: the page looks clear. Look at it before you act.`,
    clearedOnItsOwn: (site: string): string =>
        `${siteName(site)} showed a check page, which cleared on its own after a short wait. This is the page now: look at it before you act.`,
    lookBudgetSpent: "The page could not be looked at again during this browser action. Look at it yourself before you act.",
    stillShowsAfterHandBack: (site: string): string =>
        `${siteName(site)} still shows a check after the person handed the browser back. They were already asked to clear it, so they are not asked again. Do not try to solve or get around it: tell them it still shows, or reach what you need another way.`,
    unknownAfterHandBack: (site: string): string =>
        `Whether the check on ${siteName(site)} cleared is unknown: the page's text could not be read after the hand back. Look at the page before you act, and do not try to solve or get around a check that still shows.`,
};

const siteName = (site: string): string => (site === "" ? "The page" : site);

/** The fields of a browser result the ladder reads and writes. */
export interface LadderResult extends PageSignals {
    error?: string;
    /** The person had driven the browser and gave it back; this is the first look at the page since. */
    handedBack?: boolean;
    humanCheck?: { site: string; status: "already_asked" | "asked" };
    screenshot?: string;
    screenshotFormat?: string;
    success?: boolean;
}

/**
 * How an ask arose: the page showed a check (`detected`), or the agent said a person is needed (`reported`, e.g. a
 * sign-in wall), which no marker shows, so its absence after a hand back proves nothing.
 */
export type HumanCheckAskKind = "detected" | "reported";

export interface LadderDependencies<R extends LadderResult> {
    /** Records that the person is asked about `site` in this run, and how: `false` when they already were. */
    claimAsk: (site: string, kind: HumanCheckAskKind) => Promise<boolean>;
    /** A fresh look at the page through the usual action path: the whole page's text for a check found in it. */
    look: (kind: "extract" | "screenshot") => Promise<R>;
    /** Waits `ms` between two actions (no browser hold is kept meanwhile): `false` when the run was stopped during it. */
    sleep: (ms: number) => Promise<boolean>;
    /**
     * How the person was asked about `site` in this run (`run`), or in this run or one of the thread's within the last
     * {@link HUMAN_CHECK_HAND_BACK_WINDOW_MS} (`recent`, the latest ask); `undefined` when they were not.
     */
    wasAsked: (site: string, scope: "recent" | "run") => Promise<HumanCheckAskKind | undefined>;
}

/**
 * `reported`: the agent itself said a person is needed (a sign-in wall). `readContent`: see {@link detectHumanCheck}.
 * `navigated`: an interactive action (click, type, scroll) left the page on another URL; its result carries no title
 * or text, so one whole-page text read looks for a check there before the page counts as having none.
 */
export interface LadderOptions {
    navigated?: boolean;
    readContent?: boolean;
    reported?: boolean;
}

/**
 * Waits `ms`, or less when `signal` aborts (the person pressed Stop): `true` when the whole wait passed. The timer is
 * cleared on abort, so a stopped run keeps no invocation alive for it.
 */
export const waitUnlessStopped = async (ms: number, signal?: AbortSignal): Promise<boolean> => {
    if (signal?.aborted === true) {
        return false;
    }

    return await new Promise<boolean>((resolve) => {
        const onAbort = (): void => {
            clearTimeout(timer);
            resolve(false);
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve(true);
        }, ms);

        signal?.addEventListener("abort", onAbort, { once: true });
    });
};

/** The signals a look must carry, besides showing no check, for a check found by each marker to count as gone. */
const CLEAR_EVIDENCE: Record<HumanCheckMarker, ReadonlyArray<keyof PageSignals>> = {
    content: ["content", "title", "url"],
    title: ["title", "url"],
    url: ["url"],
};

/**
 * Positive evidence that the check on `site` is gone: a successful look, still on `site`, that carries every signal the
 * check was found by (the whole page's text for a check found in it), the one that found it not blank, and shows no
 * check in any of them. A failed look, one missing a signal or reading it blank, or one on another page (a fresh blank browser after the session died, a site the person went
 * on to) proves nothing.
 */
const showsClear = (page: LadderResult, marker: HumanCheckMarker, site: string): boolean =>
    page.success === true &&
    site !== "" &&
    humanCheckSite(page.url) === site &&
    CLEAR_EVIDENCE[marker].every((signal) => page[signal] !== undefined) &&
    // A blank read of the signal the check was found by shows nothing, so it proves nothing.
    page[marker]?.trim() !== "" &&
    detectHumanCheck(page, marker === "content") === undefined;

/**
 * `look`, answering `spent` (a failed look) once it ran `budget` times: the ladder's own reads stay bounded although
 * no rate limit counts them ({@link HUMAN_CHECK_LOOK_BUDGET}). Make one per tool call.
 */
export const budgetedLook = <R extends LadderResult>(
    look: LadderDependencies<R>["look"],
    spent: R,
    budget = HUMAN_CHECK_LOOK_BUDGET,
): LadderDependencies<R>["look"] => {
    let left = budget;

    return async (kind) => {
        if (left <= 0) {
            return spent;
        }

        left -= 1;

        return await look(kind);
    };
};

/**
 * The page the person handed back still shows a check on a site they were asked to clear one on (in this reply or a
 * recent one): the agent hears so, and nobody is waited for or asked again. Nothing is recorded: a new row would
 * restart {@link HUMAN_CHECK_HAND_BACK_WINDOW_MS} although no card was shown.
 */
const stillShowsAfterHandBack = <R extends LadderResult>(result: R, site: string): R => {
    return { ...withNote(result, humanCheckMessages.stillShowsAfterHandBack(site)), humanCheck: { site, status: "already_asked" }, success: false };
};

/** Whether the person was asked to clear a check (not to sign in, say) on `site` in this reply or a recent one. */
const askedToClearRecently = async <R extends LadderResult>(dependencies: LadderDependencies<R>, site: string): Promise<boolean> =>
    (await dependencies.wasAsked(site, "recent")) === "detected";

/** A look that threw (the action call failed) is a failed look, never an error out of the ladder after an ask is recorded. */
const safeLook = async <R extends LadderResult>(dependencies: LadderDependencies<R>, kind: "extract" | "screenshot"): Promise<R | LadderResult> => {
    try {
        return await dependencies.look(kind);
    } catch (error) {
        return { error: error instanceof Error ? error.message : String(error), success: false };
    }
};

const withNote = <R extends LadderResult>(result: R, note: string): R => {
    return { ...result, error: result.error === undefined ? note : `${result.error} ${note}` };
};

/**
 * One step of the ladder over an action's `result`. A reported page is asked about at once, with no wait. A page with
 * no check passes through, with a note when it is the first look after the person cleared one.
 */
export const humanCheckLadder = async <R extends LadderResult>(
    result: R,
    dependencies: LadderDependencies<R>,
    { navigated = false, readContent = false, reported = false }: LadderOptions = {},
): Promise<R> => {
    const marker = reported ? undefined : detectHumanCheck(result, readContent);

    if (!reported && marker === undefined) {
        if (result.handedBack === true) {
            return await afterHandBack(result, dependencies, readContent);
        }

        return navigated && result.success === true && !readContent ? await afterNavigation(result, dependencies) : result;
    }

    // The site the check was found on: what is asked about, whatever page a later look lands on.
    const site = humanCheckSite(result.url);

    // A hand back that still shows a check on a site the person was asked to clear one on, also in an earlier reply:
    // they are not waited for nor asked again. A site nobody was asked about recently, or only to sign in, goes up the
    // ladder as usual.
    if (marker !== undefined && result.handedBack === true && (await askedToClearRecently(dependencies, site))) {
        return stillShowsAfterHandBack(result, site);
    }

    // One ask per site per reply: a second block is not waited out nor asked about again. A report on a site asked
    // about for a check is still recorded as one, so its hand back is not read as cleared.
    const askedInRun = await dependencies.wasAsked(site, "run");

    if (askedInRun !== undefined) {
        if (reported && askedInRun === "detected") {
            await dependencies.claimAsk(site, "reported");
        }

        return { ...withNote(result, humanCheckMessages.alreadyAsked(site)), humanCheck: { site, status: "already_asked" }, success: false };
    }

    let page = result;

    if (marker !== undefined) {
        // Stopped during the wait: the run is ending, so nothing more is looked at or asked.
        if (!(await dependencies.sleep(HUMAN_CHECK_WAIT_MS))) {
            return result;
        }

        // A check found only in the text is looked for in the text again: a screenshot carries none.
        page = await dependencies.look(marker === "content" ? "extract" : "screenshot");

        // The look was refused or failed (a person took control meanwhile, the browser closed, also after a hand back):
        // that is what the agent hears, never a clear page, and nobody is asked to take control of a browser that is gone.
        if (page.success !== true) {
            return page;
        }

        // A person took control during the wait and handed back a page that shows no check: they are not asked about the
        // page they just gave back (an empty browser, another site), and the agent hears whether it is known to be clear.
        if (page.handedBack === true && detectHumanCheck(page, marker === "content") === undefined) {
            return showsClear(page, marker, site) ? page : withNote(page, humanCheckMessages.unknownAfterHandBack(site));
        }

        if (showsClear(page, marker, site)) {
            return withNote(page, humanCheckMessages.clearedOnItsOwn(site));
        }

        // A person took control during the wait and handed back the check still showing, after an earlier reply's ask.
        if (page.handedBack === true && (await askedToClearRecently(dependencies, site))) {
            return stillShowsAfterHandBack(page, site);
        }
    }

    const first = await dependencies.claimAsk(site, reported ? "reported" : "detected");

    // The card shows the person the page: a check re-read from the text has no image yet, so one screenshot is taken.
    // A failed one leaves the card to say it has none.
    if (first && page.screenshot === undefined) {
        const shot = await safeLook(dependencies, "screenshot");

        if (shot.success === true && shot.screenshot !== undefined) {
            page = { ...page, screenshot: shot.screenshot, screenshotFormat: shot.screenshotFormat };
        }

        // The person took control and gave it back meanwhile: the agent still hears that.
        if (shot.handedBack === true && shot.error !== undefined) {
            page = withNote(page, shot.error);
        }
    }

    return {
        ...withNote(page, first ? humanCheckMessages.asked(site) : humanCheckMessages.alreadyAsked(site)),
        humanCheck: { site, status: first ? "asked" : "already_asked" },
        success: false,
    };
};

/**
 * The first look after a hand back, on a site the person was asked about in this reply or in a recent one (the reply
 * before the follow-up that resumed it, within {@link HUMAN_CHECK_HAND_BACK_WINDOW_MS}): an older ask is not what the
 * person cleared, so a later hand back on that site hears no note about it. A screenshot, or a failed action, shows no page text, so the whole page's text is read:
 * the page is clear only when that read shows no check, still blocked when it shows one, and unknown when it failed.
 */
const afterHandBack = async <R extends LadderResult>(result: R, dependencies: LadderDependencies<R>, readContent: boolean): Promise<R> => {
    const site = humanCheckSite(result.url);
    const asked = await dependencies.wasAsked(site, "recent");

    if (asked === undefined) {
        return result;
    }

    // What the agent asked for (a sign-in) shows no marker either way: only the agent can tell whether it is done.
    if (asked === "reported") {
        return withNote(result, humanCheckMessages.afterReportedHandBack(site));
    }

    const page = readContent && result.success === true ? result : await safeLook(dependencies, "extract");

    if (showsClear(page, "content", site)) {
        return withNote(result, humanCheckMessages.clearedAfterHandBack(site));
    }

    if (page.success === true && detectHumanCheck(page, true) !== undefined) {
        const pageSite = humanCheckSite(page.url);

        // The read landed on another site's check: that check is its own, asked about (or not) under its own site.
        if (pageSite !== site) {
            const own = await humanCheckLadder({ ...page, handedBack: undefined } as R, dependencies, { readContent: true });

            // The hand-back note comes first, also when the ladder added none (Stop during its wait).
            return result.error === undefined ? own : { ...own, error: own.error === undefined ? result.error : `${result.error} ${own.error}` };
        }

        return stillShowsAfterHandBack(result, site);
    }

    return withNote(result, humanCheckMessages.unknownAfterHandBack(site));
};

/**
 * After an action that left the page on another URL: one whole-page text read, and a check it shows goes up the
 * ladder as that read (the action's own fields kept), and so does a read that came back after a hand back. A read that
 * fails or shows no check changes nothing: the action's result goes back as it was, and its text is not added.
 */
const afterNavigation = async <R extends LadderResult>(result: R, dependencies: LadderDependencies<R>): Promise<R> => {
    const page = await safeLook(dependencies, "extract");

    // The person took control meanwhile: their hand back is what the agent hears about, through the ladder.
    if (page.handedBack !== true && (page.success !== true || detectHumanCheck(page, true) === undefined)) {
        return result;
    }

    return { ...result, ...(await humanCheckLadder(page as R, dependencies, { readContent: true })) };
};
