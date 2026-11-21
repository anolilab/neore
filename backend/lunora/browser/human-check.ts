/**
 * A page only a person can clear (a human-verification challenge, a bot-check interstitial, a sign-in wall the agent
 * reports): the agent waits once for it to clear on its own, then asks the person once per site per reply, and after
 * they hand the browser back it is told whether the page is clear. Detection reads only what the renderer returns
 * (title, URL, extracted text): deterministic, no model call. Pure, so each step is tested without the provider.
 */

/** How long the agent waits for an interstitial to clear on its own before it asks the person. */
export const HUMAN_CHECK_WAIT_MS = 8000;

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

/** Phrases a short whole page shows when it asks a person to prove they are one. */
const CONTENT_MARKERS: ReadonlyArray<RegExp> = [
    /verify(?:ing)? (?:that )?you are (?:a )?human/iu,
    /checking (?:if the site connection is secure|your browser before accessing)/iu,
    /enable javascript and cookies to continue/iu,
    /press (?:and|&) hold/iu,
    /complete the security check/iu,
    /i['’]?m not a robot/iu,
];

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

    if (readContent && content !== undefined && content.length <= SHORT_PAGE_CHARS && CONTENT_MARKERS.some((marker) => marker.test(content))) {
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
    alreadyAsked: (site: string): string =>
        `${siteName(site)} still shows a check that needs a person. The person was already asked to clear it during this task, so they are not asked again. Do not try to solve or get around it: move on, or reach what you need another way.`,
    asked: (site: string): string =>
        `${siteName(site)} shows a check that needs a person (a human verification or a sign-in you cannot pass), and it did not clear on its own. The person was asked in the chat to clear it in the live view. Do not try to solve or get around it, and do not use the browser on this site until they hand it back: tell them what you are waiting for, or carry on with other work.`,
    clearedAfterHandBack: (site: string): string => `The check on ${siteName(site)} no longer shows: the page looks clear. Look at it before you act.`,
    clearedOnItsOwn: (site: string): string =>
        `${siteName(site)} showed a check page, which cleared on its own after a short wait. This is the page now: look at it before you act.`,
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

export interface LadderDependencies<R extends LadderResult> {
    /** Records that the person is asked about `site` in this run: `false` when they already were. */
    claimAsk: (site: string) => Promise<boolean>;
    /** A fresh look at the page through the usual action path: the whole page's text for a check found in it. */
    look: (kind: "extract" | "screenshot") => Promise<R>;
    /** Waits `ms` between two actions (no browser hold is kept meanwhile): `false` when the run was stopped during it. */
    sleep: (ms: number) => Promise<boolean>;
    /** Whether the person was asked about `site` in this run (`run`), or in any run of the thread (`thread`). */
    wasAsked: (site: string, scope: "run" | "thread") => Promise<boolean>;
}

/** `reported`: the agent itself said a person is needed (a sign-in wall). `readContent`: see {@link detectHumanCheck}. */
export interface LadderOptions {
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
 * Positive evidence that a check is gone: a successful look that carries every signal the check was found by (the
 * whole page's text for a check found in it) and shows no check in any of them. A failed look, or one missing a
 * signal, proves nothing.
 */
const showsClear = (page: LadderResult, marker: HumanCheckMarker): boolean =>
    page.success === true && CLEAR_EVIDENCE[marker].every((signal) => page[signal] !== undefined) && detectHumanCheck(page, marker === "content") === undefined;

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
    { readContent = false, reported = false }: LadderOptions = {},
): Promise<R> => {
    const marker = reported ? undefined : detectHumanCheck(result, readContent);

    if (!reported && marker === undefined) {
        return result.handedBack === true ? await afterHandBack(result, dependencies, readContent) : result;
    }

    let site = humanCheckSite(result.url);

    // One ask per site per reply: a second block is not waited out nor asked about again.
    if (await dependencies.wasAsked(site, "run")) {
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

        // The look was refused or failed (a person took control meanwhile, the browser closed): that is what the agent
        // hears, never a clear page.
        if (page.success !== true && page.handedBack !== true) {
            return page;
        }

        if (showsClear(page, marker)) {
            return withNote(page, humanCheckMessages.clearedOnItsOwn(site));
        }

        site = humanCheckSite(page.url ?? result.url);
    }

    const first = await dependencies.claimAsk(site);

    // The card shows the person the page: a check re-read from the text has no image yet, so one screenshot is taken.
    // A failed one leaves the card to say it has none.
    if (first && page.screenshot === undefined) {
        const shot = await dependencies.look("screenshot");

        if (shot.success === true && shot.screenshot !== undefined) {
            page = { ...page, screenshot: shot.screenshot, screenshotFormat: shot.screenshotFormat };
        }
    }

    return {
        ...withNote(page, first ? humanCheckMessages.asked(site) : humanCheckMessages.alreadyAsked(site)),
        humanCheck: { site, status: first ? "asked" : "already_asked" },
        success: false,
    };
};

/**
 * The first look after a hand back, on a site the person was asked about in the thread (this reply, or the one before
 * the follow-up that resumed it). A screenshot, or a failed action, shows no page text, so the whole page's text is read:
 * the page is clear only when that read shows no check, still blocked when it shows one, and unknown when it failed.
 */
const afterHandBack = async <R extends LadderResult>(result: R, dependencies: LadderDependencies<R>, readContent: boolean): Promise<R> => {
    const site = humanCheckSite(result.url);

    if (!(await dependencies.wasAsked(site, "thread"))) {
        return result;
    }

    const page = readContent && result.success === true ? result : await dependencies.look("extract");

    if (showsClear(page, "content")) {
        return withNote(result, humanCheckMessages.clearedAfterHandBack(site));
    }

    if (page.success === true && detectHumanCheck(page, true) !== undefined) {
        return { ...withNote(result, humanCheckMessages.alreadyAsked(site)), humanCheck: { site, status: "already_asked" }, success: false };
    }

    return withNote(result, humanCheckMessages.unknownAfterHandBack(site));
};
