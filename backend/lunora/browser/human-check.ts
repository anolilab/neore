/**
 * A page only a person can clear (a human-verification challenge, a bot-check interstitial, a sign-in wall the agent
 * reports): the agent waits once for it to clear on its own, then asks the person once per site per run, and after
 * they hand the browser back it is told whether the page is clear. Detection reads only what the renderer returns
 * (title, URL, extracted text): deterministic, no model call. Pure, so each step is tested without the provider.
 */

/** How long the agent waits for an interstitial to clear on its own before it asks the person. */
export const HUMAN_CHECK_WAIT_MS = 8000;

/** Extracted text longer than this is a real page that merely mentions a check, never the check itself. */
const SHORT_PAGE_CHARS = 3000;

/** Whole-title patterns of challenge and interstitial pages (trimmed, any case). */
const TITLE_MARKERS: ReadonlyArray<RegExp> = [
    /^just a moment(?:\.{3}|…)?$/iu,
    /^attention required!?/iu,
    /^(?:please )?verify(?:ing)? (?:that )?you are (?:a )?human/iu,
    /^are you a (?:human|robot)\??$/iu,
    /^(?:human|bot) (?:verification|check)\b/iu,
    /^security check(?:point)?\b/iu,
    /^checking your browser/iu,
    /^one more step$/iu,
    /^captcha\b/iu,
];

/** URL paths that only challenge pages use. */
const URL_MARKERS: ReadonlyArray<RegExp> = [/\/cdn-cgi\/challenge-platform\//iu, /\/(?:re)?captcha(?:[/?#]|$)/iu, /\/human-verification(?:[/?#]|$)/iu];

/** Phrases a short page shows when it asks a person to prove they are one. */
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

/** The marker a page shows, or `undefined` when nothing says a person is needed. */
export const detectHumanCheck = ({ content, title, url }: PageSignals): HumanCheckMarker | undefined => {
    const trimmed = title?.trim();

    if (trimmed !== undefined && TITLE_MARKERS.some((marker) => marker.test(trimmed))) {
        return "title";
    }

    if (url !== undefined && URL_MARKERS.some((marker) => marker.test(url))) {
        return "url";
    }

    if (content !== undefined && content.length <= SHORT_PAGE_CHARS && CONTENT_MARKERS.some((marker) => marker.test(content))) {
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
};

const siteName = (site: string): string => (site === "" ? "The page" : site);

/** The fields of a browser result the ladder reads and writes. */
export interface LadderResult extends PageSignals {
    error?: string;
    /** The person had driven the browser and gave it back; this is the first look at the page since. */
    handedBack?: boolean;
    humanCheck?: { site: string; status: "already_asked" | "asked" };
    success?: boolean;
}

export interface LadderDependencies<R extends LadderResult> {
    /** Records that the person is asked about `site` in this run: `false` when they already were. */
    claimAsk: (site: string) => Promise<boolean>;
    /** A fresh look at the page (a screenshot through the usual action path). */
    look: () => Promise<R>;
    sleep: (ms: number) => Promise<void>;
    /** Whether the person was asked about `site` in this run already. */
    wasAsked: (site: string) => Promise<boolean>;
}

const withNote = <R extends LadderResult>(result: R, note: string): R => {
    return { ...result, error: result.error === undefined ? note : `${result.error} ${note}` };
};

/**
 * One step of the ladder over an action's `result`. `reported`: the agent itself said a person is needed (a sign-in
 * wall): no wait, straight to asking. A page with no check passes through, with a note when the person just cleared it.
 */
export const humanCheckLadder = async <R extends LadderResult>(result: R, dependencies: LadderDependencies<R>, reported = false): Promise<R> => {
    if (!reported && detectHumanCheck(result) === undefined) {
        return result.handedBack === true ? await clearedNoteIfAsked(result, dependencies) : result;
    }

    let site = humanCheckSite(result.url);

    // One ask per site per run: a second block is not waited out nor asked about again.
    if (await dependencies.wasAsked(site)) {
        return { ...withNote(result, humanCheckMessages.alreadyAsked(site)), humanCheck: { site, status: "already_asked" }, success: false };
    }

    let page = result;

    if (!reported) {
        await dependencies.sleep(HUMAN_CHECK_WAIT_MS);
        page = await dependencies.look();

        // The look was refused or failed (a person took control meanwhile, the browser closed): that is what the agent hears.
        if (page.success !== true && page.handedBack !== true) {
            return page;
        }

        if (page.success === true && detectHumanCheck(page) === undefined) {
            return withNote(page, humanCheckMessages.clearedOnItsOwn(site));
        }

        site = humanCheckSite(page.url ?? result.url);
    }

    const first = await dependencies.claimAsk(site);

    return {
        ...withNote(page, first ? humanCheckMessages.asked(site) : humanCheckMessages.alreadyAsked(site)),
        humanCheck: { site, status: first ? "asked" : "already_asked" },
        success: false,
    };
};

const clearedNoteIfAsked = async <R extends LadderResult>(result: R, dependencies: LadderDependencies<R>): Promise<R> => {
    const site = humanCheckSite(result.url);

    return (await dependencies.wasAsked(site)) ? withNote(result, humanCheckMessages.clearedAfterHandBack(site)) : result;
};
