/**
 * The human-check ladder: detection from what the renderer returns, the one wait, the one ask per site per run, and
 * what the agent hears after the person hands the browser back.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import schema from "../schema";
import { deleteAllForThreadIdAsync } from "../agent/threads";
import { claimHumanCheckAsk, wasHumanCheckAsked } from "./functions";
import { BATCH } from "../gdpr/batch";
import { eraseBrowserDataForUser } from "./gdpr";
import {
    budgetedLook,
    detectHumanCheck,
    HUMAN_CHECK_HAND_BACK_WINDOW_MS,
    HUMAN_CHECK_WAIT_MS,
    humanCheckLadder,
    type HumanCheckAskKind,
    humanCheckSite,
    type LadderDependencies,
    type LadderResult,
    waitUnlessStopped,
} from "./human-check";

/** What the agent hears at each step, as far as these tests read it. */
const CLEARED_NOTE = /cleared on its own.*look at it before you act/su;
const ASKED_NOTE = /asked in the chat.*Do not try to solve or get around it/su;
/** The ask keeps no browser alive: the agent hears that a later retry starts on a new one. */
const ASKED_BROWSER_CLOSES_NOTE = /closes about a minute after its last action.*opens a new browser, so navigate to the page again/su;
const ALREADY_ASKED_NOTE = /already asked.*move on, or reach what you need another way/su;
const CLEAR_AFTER_HAND_BACK_NOTE = /handed it back;.*no longer shows: the page looks clear\. Look at it before you act\./su;
/** The hand-back note, then the ask about the other site the read landed on. */
const HAND_BACK_THEN_OTHER_ASK_NOTE = /^The person had control.*other\.example\.org shows a check/su;
const REPORTED_HAND_BACK_NOTE = /handed the browser back after you asked them about portal\.example\.com.*before you act/su;
const STILL_SHOWS_AFTER_HAND_BACK_NOTE = /still shows a check after the person handed the browser back.*not asked again/su;
const UNKNOWN_AFTER_HAND_BACK_NOTE = /cleared is unknown.*Look at the page before you act/su;
const UNKNOWN_LONG_PAGE_NOTE = /cleared is unknown: the page now has too much text to tell/u;
/** Why the read of a new page failed, at the end of the note. */
const READ_FAILED_REASON = /Navigation timeout$/u;
/** Why the ladder's own look failed, at the end of the note. */
const LOOK_FAILED_REASON = /Renderer down$/u;
const HAND_BACK_THEN_CLEARED_NOTE = /^The person had control; .*cleared on its own/su;
const SKIPPED_ACTION_NOTE = /Your click action was not run/gu;
const NAVIGATION_UNCHECKED_NOTE = /the new page could not be read to see whether it shows a check.*Look at it before you act/su;

const CHECK_PAGE: LadderResult = { success: true, title: "Just a moment...", url: "https://shop.example.com/item" };
const CLEAR_PAGE: LadderResult = { success: true, title: "Item 42 – Shop", url: "https://shop.example.com/item" };
/** The whole page's text read back, with no check in it: the only look that proves a check is gone after a hand back. */
const CLEAR_EXTRACT: LadderResult = { ...CLEAR_PAGE, content: "Item 42. Add to cart." };
const TEXT_CHECK: LadderResult = { content: "Verifying you are human.", success: true, title: "shop.example.com", url: "https://shop.example.com/" };
/** A whole-page read past what the text detector reads: whether a check is in it cannot be told. */
const LONG_EXTRACT: LadderResult = { ...CLEAR_PAGE, content: "Item 42. ".repeat(400) };
/** A read the renderer cut short (its own marker appended), which the detector cannot read either. */
const TRUNCATED_EXTRACT: LadderResult = { ...CLEAR_PAGE, content: `${"Item 42. ".repeat(1700)}\n\n[Content truncated]`, truncated: true };

/**
 * Dependencies over in-memory sets of sites asked about in this run (`asked`) and in the thread's recent earlier
 * runs (`earlier`), of which `reported` were the agent's own reports and `inText` checks found only in the text; `looks`
 * are the pages the fresh looks return, in order.
 */
const dependenciesFor = (
    looks: LadderResult[],
    asked = new Set<string>(),
    earlier = new Set<string>(),
    reported = new Set<string>(),
    inText = new Set<string>(),
) => {
    const kindOf = (site: string): HumanCheckAskKind => {
        if (reported.has(site)) {
            return "reported";
        }

        return inText.has(site) ? "detected_in_text" : "detected";
    };
    const dependencies = {
        claimAsk: vi.fn(async (site: string, kind: HumanCheckAskKind) => {
            if (asked.has(site)) {
                return false;
            }

            asked.add(site);

            if (kind === "detected_in_text") {
                inText.add(site);
            }

            return true;
        }),
        look: vi.fn(async (_kind: "extract" | "screenshot") => looks.shift() ?? CLEAR_PAGE),
        sleep: vi.fn(async (_ms: number) => true),
        wasAsked: vi.fn(async (site: string, scope: "recent" | "run") =>
            asked.has(site) || (scope === "recent" && earlier.has(site)) ? kindOf(site) : undefined,
        ),
    } satisfies LadderDependencies<LadderResult>;

    return { asked, dependencies };
};

describe("detectHumanCheck", () => {
    it.each([
        [{ title: "Just a moment..." }, "title"],
        [{ title: "  Attention Required! | Example  " }, "title"],
        [{ title: "Verify you are human" }, "title"],
        [{ title: "Are you a robot?" }, "title"],
        [{ url: "https://example.com/cdn-cgi/challenge-platform/h/b/orchestrate" }, "url"],
        [{ url: "https://example.com/item?__cf_chl_rt_tk=abc" }, "url"],
        [{ url: "https://example.com/item?a=1&__cf_chl_f_tk=abc#top" }, "url"],
        [{ title: "Checking your browser before accessing example.com" }, "title"],
        [{ content: "Verifying you are human. This may take a few seconds.", title: "example.com" }, "content"],
        [{ content: "Press & Hold to confirm you are a human (and not a bot)." }, "content"],
    ])("reads %j as a check (%s)", (page, marker) => {
        expect(detectHumanCheck(page, true)).toBe(marker);
    });

    it("reads a page's text only when it is the whole page's", () => {
        expect(detectHumanCheck({ content: "Verifying you are human." })).toBeUndefined();
    });

    it.each([
        { title: "How captchas work – a guide" },
        { title: "CAPTCHA - Wikipedia" },
        { title: "Security Checkpoint Wait Times – Airport" },
        { title: "Human verification methods compared" },
        { title: "Attention required: update your profile" },
        { title: "Just a moment of your time: our survey" },
        { url: "https://developers.example.com/recaptcha/docs" },
        { url: "https://example.com/blog/captcha-alternatives" },
        // The challenge's path or key only as text in a query value or the fragment of an ordinary link.
        { url: "https://example.com/search?q=/cdn-cgi/challenge-platform/h/b" },
        { url: "https://example.com/docs#/cdn-cgi/challenge-platform/" },
        { url: "https://example.com/item?next=%3F__cf_chl_rt_tk%3Dabc" },
        { url: "https://example.com/item#?__cf_chl_rt_tk=abc" },
        { url: "https://example.com/docs/cdn-cgi/challenge-platform/" },
        { url: "not a url /cdn-cgi/challenge-platform/" },
        // Short help pages with a phrase a challenge also uses, and no second sign of one.
        { content: "To restart the phone, press and hold the power button for ten seconds.", title: "Restart your phone" },
        { content: "Why does the form ask me to tick “I'm not a robot”? It keeps spam out.", title: "FAQ" },
        // A long article that mentions the phrase is a real page.
        { content: `${"An article about bots. ".repeat(200)}Verify you are human, it says.` },
        {},
    ])("leaves %j alone", (page) => {
        expect(detectHumanCheck(page, true)).toBeUndefined();
    });
});

describe("humanCheckSite", () => {
    it("names the host, lower case, and nothing for an unreadable URL", () => {
        expect(humanCheckSite("https://Shop.Example.com/a?b=1")).toBe("shop.example.com");
        expect(humanCheckSite("not a url")).toBe("");
        expect(humanCheckSite(undefined)).toBe("");
    });
});

describe("humanCheckLadder", () => {
    it("passes a page with no check through untouched", async () => {
        const { dependencies } = dependenciesFor([]);

        await expect(humanCheckLadder(CLEAR_PAGE, dependencies)).resolves.toBe(CLEAR_PAGE);
        expect(dependencies.sleep).not.toHaveBeenCalled();
        expect(dependencies.claimAsk).not.toHaveBeenCalled();
    });

    it("step 1: waits once, and a check that cleared on its own asks nobody", async () => {
        const { dependencies } = dependenciesFor([CLEAR_PAGE]);
        const result = await humanCheckLadder(CHECK_PAGE, dependencies);

        expect(dependencies.sleep).toHaveBeenCalledExactlyOnceWith(HUMAN_CHECK_WAIT_MS);
        expect(dependencies.look).toHaveBeenCalledExactlyOnceWith("screenshot");
        expect(dependencies.claimAsk).not.toHaveBeenCalled();
        expect(result).toMatchObject({ success: true, title: CLEAR_PAGE.title });
        expect(result.humanCheck).toBeUndefined();
        expect(result.error).toMatch(CLEARED_NOTE);
    });

    it("step 1: a check found in the page's text is looked for in the text again, then shot once for the card", async () => {
        const { dependencies } = dependenciesFor([TEXT_CHECK, { ...CLEAR_PAGE, screenshot: "jpeg", screenshotFormat: "jpeg" }]);
        const result = await humanCheckLadder(TEXT_CHECK, dependencies, { readContent: true });

        expect(dependencies.look.mock.calls).toStrictEqual([["extract"], ["screenshot"]]);
        expect(result).toMatchObject({ humanCheck: { site: "shop.example.com", status: "asked" }, screenshot: "jpeg", screenshotFormat: "jpeg" });
    });

    it("step 1: a failed screenshot for the card still asks, with no image", async () => {
        const { dependencies } = dependenciesFor([TEXT_CHECK, { error: "Browser closed", success: false }]);
        const result = await humanCheckLadder(TEXT_CHECK, dependencies, { readContent: true });

        expect(result.humanCheck).toEqual({ site: "shop.example.com", status: "asked" });
        expect(result.screenshot).toBeUndefined();
    });

    it("step 1: a text check is not clear on a look that read no text", async () => {
        const { dependencies } = dependenciesFor([CLEAR_PAGE]);
        const result = await humanCheckLadder(TEXT_CHECK, dependencies, { readContent: true });

        expect(result.humanCheck?.status).toBe("asked");
        expect(result.error).not.toMatch(CLEARED_NOTE);
    });

    it("step 1: a title check is not clear on a look with no title", async () => {
        const { dependencies } = dependenciesFor([{ screenshot: "jpeg", success: true }]);
        const result = await humanCheckLadder(CHECK_PAGE, dependencies);

        expect(result.humanCheck?.status).toBe("asked");
        expect(result.error).not.toMatch(CLEARED_NOTE);
    });

    it("step 1: Stop during the wait ends it there: nothing more is looked at or asked", async () => {
        const { dependencies } = dependenciesFor([]);

        dependencies.sleep.mockResolvedValueOnce(false);

        await expect(humanCheckLadder(CHECK_PAGE, dependencies)).resolves.toBe(CHECK_PAGE);
        expect(dependencies.look).not.toHaveBeenCalled();
        expect(dependencies.claimAsk).not.toHaveBeenCalled();
    });

    it("step 2: still blocked after the wait, the person is asked, and told not to solve it", async () => {
        const { asked, dependencies } = dependenciesFor([{ ...CHECK_PAGE, screenshot: "jpeg" } as LadderResult]);
        const result = await humanCheckLadder(CHECK_PAGE, dependencies);

        expect(asked).toEqual(new Set(["shop.example.com"]));
        expect(result).toMatchObject({ humanCheck: { site: "shop.example.com", status: "asked" }, screenshot: "jpeg", success: false });
        expect(result.error).toMatch(ASKED_NOTE);
    });

    it("step 2: a second block on the same site in the run is neither waited out nor asked again", async () => {
        const { dependencies } = dependenciesFor([], new Set(["shop.example.com"]));
        const result = await humanCheckLadder(CHECK_PAGE, dependencies);

        expect(dependencies.sleep).not.toHaveBeenCalled();
        expect(dependencies.claimAsk).not.toHaveBeenCalled();
        expect(result).toMatchObject({ humanCheck: { site: "shop.example.com", status: "already_asked" }, success: false });
        expect(result.error).toMatch(ALREADY_ASKED_NOTE);
    });

    it("step 2: another site in the same run is asked about on its own", async () => {
        const { asked, dependencies } = dependenciesFor([{ ...CHECK_PAGE, url: "https://other.example.org/" }], new Set(["shop.example.com"]));
        const result = await humanCheckLadder({ ...CHECK_PAGE, url: "https://other.example.org/" }, dependencies);

        expect(result.humanCheck).toEqual({ site: "other.example.org", status: "asked" });
        expect(asked.has("other.example.org")).toBe(true);
    });

    it("step 2: an action at the same time that asked first makes this one hear `already_asked`", async () => {
        const { dependencies } = dependenciesFor([CHECK_PAGE]);

        dependencies.claimAsk.mockResolvedValueOnce(false);

        await expect(humanCheckLadder(CHECK_PAGE, dependencies)).resolves.toMatchObject({ humanCheck: { status: "already_asked" } });
    });

    it("step 2: a look refused meanwhile (a person took control) is what the agent hears, with no ask", async () => {
        const refused = { error: "The person watching this chat has taken control of the browser", success: false };
        const { dependencies } = dependenciesFor([refused]);

        await expect(humanCheckLadder(CHECK_PAGE, dependencies)).resolves.toBe(refused);
        expect(dependencies.claimAsk).not.toHaveBeenCalled();
    });

    it("a report on a site the run asked about for a check records it as reported, with no second ask", async () => {
        const { dependencies } = dependenciesFor([], new Set(["shop.example.com"]));
        const result = await humanCheckLadder(CLEAR_PAGE, dependencies, { reported: true });

        expect(dependencies.claimAsk).toHaveBeenCalledExactlyOnceWith("shop.example.com", "reported");
        expect(result.humanCheck).toEqual({ site: "shop.example.com", status: "already_asked" });
    });

    it("the agent's own report asks at once, with no wait, and is recorded as reported", async () => {
        const signIn: LadderResult = { success: true, title: "Sign in", url: "https://portal.example.com/login" };
        const { dependencies } = dependenciesFor([]);
        const result = await humanCheckLadder(signIn, dependencies, { reported: true });

        expect(dependencies.sleep).not.toHaveBeenCalled();
        expect(dependencies.claimAsk).toHaveBeenCalledExactlyOnceWith("portal.example.com", "reported");
        expect(result.humanCheck).toEqual({ site: "portal.example.com", status: "asked" });
    });

    it("step 3: after a hand back on a page the agent reported (a sign-in wall), it is told to check, never that it looks clear", async () => {
        const signIn = "portal.example.com";
        const { dependencies } = dependenciesFor([], new Set(), new Set([signIn]), new Set([signIn]));
        const result = await humanCheckLadder(
            {
                error: "The person had control of the browser and handed it back;",
                handedBack: true,
                success: true,
                title: "Sign in",
                url: "https://portal.example.com/login",
            },
            dependencies,
        );

        expect(dependencies.look).not.toHaveBeenCalled();
        expect(result.error).not.toMatch(CLEAR_AFTER_HAND_BACK_NOTE);
        expect(result.error).toMatch(REPORTED_HAND_BACK_NOTE);
    });

    it("a click that lands on a check at an ordinary URL is caught by one text read", async () => {
        const clicked: LadderResult & { clickedSelector: string } = { clickedSelector: "#buy", success: true, url: "https://shop.example.com/checkout" };
        const challenge: LadderResult = { content: "", success: true, title: "Just a moment...", url: "https://shop.example.com/checkout" };
        const { dependencies } = dependenciesFor([challenge, { ...challenge, screenshot: "jpeg" }]);
        const result = await humanCheckLadder<LadderResult>(clicked, dependencies, { navigated: true });

        expect(dependencies.look.mock.calls).toStrictEqual([["extract"], ["screenshot"]]);
        expect(result).toMatchObject({ clickedSelector: "#buy", humanCheck: { site: "shop.example.com", status: "asked" }, success: false });
    });

    it("a click that moved on to a page with no check costs one read and returns as it was", async () => {
        const clicked = { clickedSelector: "#next", success: true, url: "https://shop.example.com/page-2" };
        const { dependencies } = dependenciesFor([{ ...CLEAR_EXTRACT, url: clicked.url }]);

        await expect(humanCheckLadder<LadderResult>(clicked, dependencies, { navigated: true })).resolves.toBe(clicked);
        expect(dependencies.look).toHaveBeenCalledExactlyOnceWith("extract");
        // A click that stayed on its page reads nothing more.
        await expect(humanCheckLadder<LadderResult>(clicked, dependenciesFor([]).dependencies)).resolves.toBe(clicked);
    });

    it("a click that moved on, whose read of the new page failed, still succeeds and says the page was not checked", async () => {
        const clicked = { clickedSelector: "#next", success: true, url: "https://shop.example.com/page-2" };
        const { dependencies } = dependenciesFor([{ error: "Navigation timeout", success: false }]);
        const result = await humanCheckLadder<LadderResult>(clicked, dependencies, { navigated: true });

        expect(result).toMatchObject({ clickedSelector: "#next", success: true });
        expect(result.error).toMatch(NAVIGATION_UNCHECKED_NOTE);
        // Why the read failed (a person took control, say) reaches the agent too.
        expect(result.error).toMatch(READ_FAILED_REASON);
        expect(result.humanCheck).toBeUndefined();
        expect(dependencies.claimAsk).not.toHaveBeenCalled();
    });

    it("step 3: after the hand back, a page whose text shows no check is clear, also in the next run", async () => {
        const { dependencies } = dependenciesFor([CLEAR_EXTRACT], new Set(), new Set(["shop.example.com"]));
        const result = await humanCheckLadder(
            { ...CLEAR_PAGE, error: "The person had control of the browser and handed it back;", handedBack: true },
            dependencies,
        );

        // A screenshot carries no text: the page's text is read before anything is called clear.
        expect(dependencies.look).toHaveBeenCalledExactlyOnceWith("extract");
        expect(result.humanCheck).toBeUndefined();
        expect(result.error).toMatch(CLEAR_AFTER_HAND_BACK_NOTE);
    });

    it.each([
        ["too long to read", LONG_EXTRACT],
        ["cut short by the renderer", TRUNCATED_EXTRACT],
    ])("step 3: a read after the hand back %s is unknown for a check found in the text, and clear for one found by its title", async (_why, page) => {
        const site = new Set(["shop.example.com"]);
        const inText = dependenciesFor([page], site, new Set(), new Set(), new Set(site)).dependencies;
        const result = await humanCheckLadder({ ...CLEAR_PAGE, handedBack: true }, inText);

        expect(result.error).toMatch(UNKNOWN_LONG_PAGE_NOTE);
        expect(result.error).not.toMatch(CLEAR_AFTER_HAND_BACK_NOTE);
        expect(result.humanCheck).toBeUndefined();

        const byTitle = dependenciesFor([page], new Set(site)).dependencies;

        await expect(
            humanCheckLadder({ ...CLEAR_PAGE, error: "The person had control of the browser and handed it back;", handedBack: true }, byTitle),
        ).resolves.toMatchObject({
            error: expect.stringMatching(CLEAR_AFTER_HAND_BACK_NOTE),
        });
    });

    it("a check found in the text is asked about as such, so its hand back needs text short enough to read", async () => {
        const { dependencies } = dependenciesFor([TEXT_CHECK, { ...TEXT_CHECK, screenshot: "jpeg" }]);

        await humanCheckLadder(TEXT_CHECK, dependencies, { readContent: true });
        expect(dependencies.claimAsk).toHaveBeenCalledExactlyOnceWith("shop.example.com", "detected_in_text");
    });

    it("step 1: a check found in the text that turned into a page too long to read is unknown: neither cleared nor asked about", async () => {
        const { dependencies } = dependenciesFor([LONG_EXTRACT]);
        const result = await humanCheckLadder(TEXT_CHECK, dependencies, { readContent: true });

        expect(result.error).toMatch(UNKNOWN_LONG_PAGE_NOTE);
        expect(result.error).not.toMatch(CLEARED_NOTE);
        expect(result.humanCheck).toBeUndefined();
        expect(dependencies.claimAsk).not.toHaveBeenCalled();

        // A title check is told by its title, whatever the page's length.
        const titled = dependenciesFor([{ ...LONG_EXTRACT, title: "Item 42 – Shop" }]).dependencies;

        await expect(humanCheckLadder(CHECK_PAGE, titled)).resolves.toMatchObject({ error: expect.stringMatching(CLEARED_NOTE) });
    });

    it("step 3: a whole-page extract handed back is its own evidence, with no second look", async () => {
        const { dependencies } = dependenciesFor([], new Set(["shop.example.com"]));
        const result = await humanCheckLadder(
            { ...CLEAR_EXTRACT, error: "The person had control of the browser and handed it back;", handedBack: true },
            dependencies,
            { readContent: true },
        );

        expect(dependencies.look).not.toHaveBeenCalled();
        expect(result.error).toMatch(CLEAR_AFTER_HAND_BACK_NOTE);
    });

    it("step 3: a check still in the page's text after the hand back is not called clear, nor asked again", async () => {
        const { dependencies } = dependenciesFor([TEXT_CHECK], new Set(["shop.example.com"]));
        const result = await humanCheckLadder({ ...CLEAR_PAGE, handedBack: true }, dependencies);

        expect(result).toMatchObject({ humanCheck: { site: "shop.example.com", status: "already_asked" }, success: false });
        expect(result.error).toMatch(STILL_SHOWS_AFTER_HAND_BACK_NOTE);
        expect(result.error).not.toMatch(CLEAR_AFTER_HAND_BACK_NOTE);
    });

    it("step 3: a failed action or a failed read after the hand back leaves it unknown, never clear", async () => {
        const failed = { error: "Browser closed", success: false };
        const { dependencies } = dependenciesFor([failed], new Set(["shop.example.com"]));
        const result = await humanCheckLadder({ error: "Timed out", handedBack: true, success: false, url: CLEAR_PAGE.url }, dependencies);

        expect(result.error).toMatch(UNKNOWN_AFTER_HAND_BACK_NOTE);
        expect(result.error).not.toMatch(CLEAR_AFTER_HAND_BACK_NOTE);
        expect(result.success).toBe(false);
    });

    it.each([
        ["this reply", new Set(["shop.example.com"]), new Set<string>()],
        ["a recent one", new Set<string>(), new Set(["shop.example.com"])],
    ])("step 3: a page still blocked after the hand back, asked about in %s, is neither waited out nor asked about again", async (_when, asked, earlier) => {
        const { dependencies } = dependenciesFor([], asked, earlier);
        const result = await humanCheckLadder({ ...CHECK_PAGE, handedBack: true }, dependencies);

        expect(result).toMatchObject({ humanCheck: { site: "shop.example.com", status: "already_asked" }, success: false });
        expect(result.error).toMatch(STILL_SHOWS_AFTER_HAND_BACK_NOTE);
        expect(dependencies.sleep).not.toHaveBeenCalled();
        expect(dependencies.look).not.toHaveBeenCalled();
        // No new row: it would restart the recent-ask window although no card was shown.
        expect(dependencies.claimAsk).not.toHaveBeenCalled();
    });

    it("step 1: a person who handed back the check still showing during the wait, after a recent reply's ask, is not asked again", async () => {
        const { dependencies } = dependenciesFor([{ ...CHECK_PAGE, handedBack: true }], new Set(), new Set(["shop.example.com"]));
        const result = await humanCheckLadder(CHECK_PAGE, dependencies);

        expect(result).toMatchObject({ humanCheck: { site: "shop.example.com", status: "already_asked" }, success: false });
        expect(result.error).toMatch(STILL_SHOWS_AFTER_HAND_BACK_NOTE);
        expect(dependencies.claimAsk).not.toHaveBeenCalled();
    });

    it.each([
        ["nobody was asked about", new Set(["other.example.org"]), new Set<string>()],
        ["the person was only asked to sign in on", new Set(["shop.example.com"]), new Set(["shop.example.com"])],
    ])("step 3: a hand back that shows a check on a site %s goes up the ladder", async (_what, earlier, reported) => {
        const { dependencies } = dependenciesFor([CHECK_PAGE], new Set(), earlier, reported);
        const result = await humanCheckLadder({ ...CHECK_PAGE, handedBack: true }, dependencies);

        expect(dependencies.sleep).toHaveBeenCalledExactlyOnceWith(HUMAN_CHECK_WAIT_MS);
        expect(result).toMatchObject({ humanCheck: { site: "shop.example.com", status: "asked" }, success: false });
    });

    it("step 1: a blank or clean page on another host after the wait is not clear, and the ask names the site the check was on", async () => {
        for (const look of [
            { content: "", success: true, title: "", url: "about:blank" },
            { content: "Welcome back.", success: true, title: "Account", url: "https://login.example.net/" },
        ]) {
            const { asked, dependencies } = dependenciesFor([look]);
            const result = await humanCheckLadder(TEXT_CHECK, dependencies, { readContent: true });

            expect(result.error).not.toMatch(CLEARED_NOTE);
            expect(result.humanCheck).toEqual({ site: "shop.example.com", status: "asked" });
            expect(asked).toEqual(new Set(["shop.example.com"]));
        }
    });

    it("step 1: a person who took control during the wait and handed back an empty browser, a blank read or another site is not asked", async () => {
        for (const look of [
            { content: "", success: true, title: "", url: "about:blank" },
            // Still on the site, but the text read came back blank: that proves nothing.
            { content: "  ", success: true, title: "", url: "https://shop.example.com/" },
            { content: "Welcome back.", success: true, title: "Account", url: "https://login.example.net/" },
        ]) {
            const handed = { ...look, error: "The person had control of the browser and handed it back;", handedBack: true };
            const { dependencies } = dependenciesFor([handed]);
            const result = await humanCheckLadder(TEXT_CHECK, dependencies, { readContent: true });

            expect(dependencies.claimAsk).not.toHaveBeenCalled();
            expect(result.humanCheck).toBeUndefined();
            expect(result.error).toMatch(UNKNOWN_AFTER_HAND_BACK_NOTE);
        }
    });

    it("step 1: a look after the wait that fails after a hand back (the browser closed) asks nobody", async () => {
        const closed: LadderResult = {
            error: "The person had control of the browser and handed it back; The browser closed.",
            handedBack: true,
            success: false,
        };
        const { dependencies } = dependenciesFor([closed]);

        await expect(humanCheckLadder(CHECK_PAGE, dependencies)).resolves.toBe(closed);
        expect(dependencies.claimAsk).not.toHaveBeenCalled();
    });

    it("step 1: a person who took control during the wait and handed back a clear page is not told it cleared on its own", async () => {
        const handed = { ...CLEAR_PAGE, error: "The person had control of the browser and handed it back;", handedBack: true };
        const { dependencies } = dependenciesFor([handed]);
        const result = await humanCheckLadder(CHECK_PAGE, dependencies);

        expect(result).toBe(handed);
        expect(dependencies.claimAsk).not.toHaveBeenCalled();
    });

    it("step 2: a screenshot for the card that throws still leaves the ask and its card", async () => {
        const { dependencies } = dependenciesFor([TEXT_CHECK]);

        dependencies.look.mockResolvedValueOnce(TEXT_CHECK).mockRejectedValueOnce(new Error("renderer down"));

        const result = await humanCheckLadder(TEXT_CHECK, dependencies, { readContent: true });

        expect(result.humanCheck).toEqual({ site: "shop.example.com", status: "asked" });
        expect(result.screenshot).toBeUndefined();
    });

    it("step 3: a read after the hand back that throws, or lands on a blank or other page, leaves it unknown", async () => {
        for (const look of [
            undefined,
            { content: "", success: true, title: "", url: "about:blank" },
            { content: "Welcome", success: true, title: "Elsewhere", url: "https://elsewhere.example.net/" },
        ]) {
            const { dependencies } = dependenciesFor([], new Set(["shop.example.com"]));

            if (look === undefined) {
                dependencies.look.mockRejectedValueOnce(new Error("renderer down"));
            } else {
                dependencies.look.mockResolvedValueOnce(look);
            }

            const result = await humanCheckLadder({ ...CLEAR_PAGE, handedBack: true }, dependencies);

            expect(result.error).toMatch(UNKNOWN_AFTER_HAND_BACK_NOTE);
            expect(result.error).not.toMatch(CLEAR_AFTER_HAND_BACK_NOTE);
        }
    });

    it("step 3: a failed hand back with no page (the browser closed) is passed on as it is, never called clear", async () => {
        const closed: LadderResult = { error: "The browser closed during the action.", handedBack: true, success: false };
        const { dependencies } = dependenciesFor([], new Set([""]));
        const result = await humanCheckLadder(closed, dependencies);

        expect(result.error).not.toMatch(CLEAR_AFTER_HAND_BACK_NOTE);
        expect(result.success).toBe(false);
    });

    it("step 3: a read after the hand back that lands on another site's check asks about that site, not the first", async () => {
        const otherCheck: LadderResult = { content: "Verifying you are human.", success: true, title: "other.example.org", url: "https://other.example.org/" };
        const { asked, dependencies } = dependenciesFor([otherCheck, otherCheck], new Set(["shop.example.com"]));
        const result = await humanCheckLadder(
            { ...CLEAR_PAGE, error: "The person had control of the browser and handed it back;", handedBack: true },
            dependencies,
        );

        expect(result.humanCheck).toEqual({ site: "other.example.org", status: "asked" });
        expect(result.error).toMatch(HAND_BACK_THEN_OTHER_ASK_NOTE);
        expect(asked).toEqual(new Set(["other.example.org", "shop.example.com"]));
    });

    it("step 3: Stop during the wait for another site's check still tells the agent the person handed back", async () => {
        const otherCheck: LadderResult = { content: "Verifying you are human.", success: true, title: "other.example.org", url: "https://other.example.org/" };
        const { dependencies } = dependenciesFor([otherCheck], new Set(["shop.example.com"]));

        dependencies.sleep.mockResolvedValueOnce(false);

        const result = await humanCheckLadder(
            { ...CLEAR_PAGE, error: "The person had control of the browser and handed it back;", handedBack: true },
            dependencies,
        );

        expect(result.error).toBe("The person had control of the browser and handed it back;");
        expect(dependencies.claimAsk).not.toHaveBeenCalled();
    });

    it("step 3: a hand back on a site nobody was asked about adds nothing", async () => {
        const { dependencies } = dependenciesFor([]);
        const handed = { ...CLEAR_PAGE, handedBack: true };

        await expect(humanCheckLadder(handed, dependencies)).resolves.toBe(handed);
    });

    it("an ask tells the agent the browser it asked about closes on its own, so a retry navigates again", async () => {
        const { dependencies } = dependenciesFor([CHECK_PAGE]);
        const result = await humanCheckLadder(CHECK_PAGE, dependencies);

        expect(result.humanCheck?.status).toBe("asked");
        expect(result.error).toMatch(ASKED_BROWSER_CLOSES_NOTE);
    });

    describe("a hand back whose action was not run, showing a check nobody was asked about", () => {
        /** What `browser-node.ts` returns for a click skipped after a hand back: a screenshot in its place. */
        const SKIPPED_NOTE = "The person had control of the browser and handed it back; the page may have changed. Your click action was not run.";
        const skipped: LadderResult = { ...CHECK_PAGE, error: SKIPPED_NOTE, handedBack: true, screenshot: "jpeg", success: false };

        it.each([
            ["the check cleared during the wait", [CLEAR_PAGE], CLEARED_NOTE, undefined],
            ["the check still shows, so the person is asked", [{ ...CHECK_PAGE, screenshot: "jpeg" }], ASKED_NOTE, "asked"],
            ["the look failed", [{ error: "Renderer down", success: false }], LOOK_FAILED_REASON, undefined],
            ["the look turned into a page too long to read", [LONG_EXTRACT], UNKNOWN_LONG_PAGE_NOTE, undefined],
        ])("keeps the hand-back note first and success: false when %s", async (_when, looks, note, status) => {
            const { dependencies } = dependenciesFor(looks);
            const page = looks[0] === LONG_EXTRACT ? { ...skipped, content: "Verifying you are human.", title: "shop.example.com" } : skipped;
            const result = await humanCheckLadder(page, dependencies, { readContent: looks[0] === LONG_EXTRACT });

            expect(result.success).toBe(false);
            expect(result.error?.startsWith(SKIPPED_NOTE)).toBe(true);
            expect(result.error).toMatch(note);
            expect(result.humanCheck?.status).toBe(status);
        });

        it("keeps success: false when the hand back's read lands on another site's check that clears during its wait", async () => {
            const otherCheck: LadderResult = {
                content: "Verifying you are human.",
                success: true,
                title: "other.example.org",
                url: "https://other.example.org/",
            };
            const otherClear: LadderResult = { content: "Welcome.", success: true, title: "Other", url: "https://other.example.org/" };
            const { dependencies } = dependenciesFor([otherCheck, otherClear], new Set(["shop.example.com"]));
            const result = await humanCheckLadder({ ...CLEAR_PAGE, error: SKIPPED_NOTE, handedBack: true, screenshot: "jpeg", success: false }, dependencies);

            expect(result.success).toBe(false);
            expect(result.error?.startsWith(SKIPPED_NOTE)).toBe(true);
            expect(result.error).toMatch(CLEARED_NOTE);
        });

        it("keeps the note once when Stop ends the wait", async () => {
            const { dependencies } = dependenciesFor([]);

            dependencies.sleep.mockResolvedValueOnce(false);

            await expect(humanCheckLadder(skipped, dependencies)).resolves.toStrictEqual(skipped);
        });

        it("keeps the note once on a page the agent reported after the hand back", async () => {
            const { dependencies } = dependenciesFor([]);
            const result = await humanCheckLadder({ ...CLEAR_PAGE, error: SKIPPED_NOTE, handedBack: true, screenshot: "jpeg", success: true }, dependencies, {
                reported: true,
            });

            expect(result.error?.match(SKIPPED_ACTION_NOTE)).toHaveLength(1);
            expect(result.humanCheck?.status).toBe("asked");
        });

        it("an action that ran is not marked failed when the check cleared during the wait", async () => {
            const { dependencies } = dependenciesFor([CLEAR_PAGE]);
            const result = await humanCheckLadder({ ...CHECK_PAGE, error: "The person had control;", handedBack: true }, dependencies);

            expect(result).toMatchObject({ success: true });
            expect(result.error).toMatch(HAND_BACK_THEN_CLEARED_NOTE);
        });
    });
});

describe("budgetedLook", () => {
    it("looks up to its budget, then answers the spent result without looking", async () => {
        const spent: LadderResult = { error: "spent", success: false };
        const look = vi.fn(async (_kind: "extract" | "screenshot") => CLEAR_EXTRACT);
        const limited = budgetedLook<LadderResult>(look, spent, 2);

        await expect(limited("extract")).resolves.toBe(CLEAR_EXTRACT);
        await expect(limited("screenshot")).resolves.toBe(CLEAR_EXTRACT);
        await expect(limited("extract")).resolves.toBe(spent);
        expect(look).toHaveBeenCalledTimes(2);
    });

    it("leaves room for the most looks one tool call makes: a failed read after a click handed back, its own read onto another site's check, the wait's look, the card", async () => {
        const clicked = { success: true, url: "https://shop.example.com/checkout" };
        const other = { content: "Verifying you are human.", success: true, title: "other.example.org", url: "https://other.example.org/" };
        const { dependencies } = dependenciesFor(
            [{ error: "Renderer down", handedBack: true, success: false, url: clicked.url }, other, other, { ...other, screenshot: "jpeg" }],
            new Set(),
            new Set(["shop.example.com"]),
        );
        const { look } = dependencies;
        const result = await humanCheckLadder<LadderResult>(
            clicked,
            { ...dependencies, look: budgetedLook(look, { error: "spent", success: false }) },
            { navigated: true },
        );

        expect(look).toHaveBeenCalledTimes(4);
        expect(result).toMatchObject({ humanCheck: { site: "other.example.org", status: "asked" }, screenshot: "jpeg" });
    });
});

describe("waitUnlessStopped", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("waits the whole time when nobody stops the run", async () => {
        const waited = waitUnlessStopped(HUMAN_CHECK_WAIT_MS, new AbortController().signal);

        await vi.advanceTimersByTimeAsync(HUMAN_CHECK_WAIT_MS);

        await expect(waited).resolves.toBe(true);
    });

    it("ends at once when Stop is pressed during the wait, and leaves no timer behind", async () => {
        const stop = new AbortController();
        const waited = waitUnlessStopped(HUMAN_CHECK_WAIT_MS, stop.signal);

        await vi.advanceTimersByTimeAsync(1000);
        stop.abort();

        await expect(waited).resolves.toBe(false);
        expect(vi.getTimerCount()).toBe(0);
    });

    it("does not wait at all for a run already stopped", async () => {
        const stop = new AbortController();

        stop.abort();

        await expect(waitUnlessStopped(HUMAN_CHECK_WAIT_MS, stop.signal)).resolves.toBe(false);
    });
});

describe("the ask record", () => {
    let harness: ReturnType<typeof lunoraTest>;
    let threadId: string;

    beforeEach(async () => {
        harness = lunoraTest(schema as never);
        threadId = (await harness.run(async (ctx: any) => await ctx.db.insert("threads", { status: "active", title: "T", userId: "u-1" }))) as string;
    });

    afterEach(() => {
        harness.close();
    });

    it("asks once per site per run, and a new run asks again", async () => {
        const claim = async (run: string, site: string) =>
            await harness.action(async (ctx: any) => await ctx.runMutation(claimHumanCheckAsk, { run, site, threadId }));
        const wasAsked = async (run: string, site: string) =>
            await harness.action(async (ctx: any) => await ctx.runQuery(wasHumanCheckAsked, { run, site, threadId }));

        await expect(wasAsked("r1", "a.example")).resolves.toBeNull();
        await expect(claim("r1", "a.example")).resolves.toBe(true);
        await expect(claim("r1", "a.example")).resolves.toBe(false);
        await expect(wasAsked("r1", "a.example")).resolves.toBe("detected");
        await expect(claim("r1", "b.example")).resolves.toBe(true);
        await expect(claim("r2", "a.example")).resolves.toBe(true);

        // A check found only in the text is told apart, so a long page after its hand back is not read as cleared.
        await harness.action(async (ctx: any) => await ctx.runMutation(claimHumanCheckAsk, { inText: true, run: "r4", site: "d.example", threadId }));
        await expect(wasAsked("r4", "d.example")).resolves.toBe("detected_in_text");

        // An ask the agent reported is told apart, so a hand back on it is not read as cleared.
        await harness.action(async (ctx: any) => await ctx.runMutation(claimHumanCheckAsk, { reported: true, run: "r3", site: "c.example", threadId }));
        await expect(wasAsked("r3", "c.example")).resolves.toBe("reported");

        // A report on a site the run already asked about for a check marks that ask, and asks nobody again.
        await expect(
            harness.action(async (ctx: any) => await ctx.runMutation(claimHumanCheckAsk, { reported: true, run: "r1", site: "a.example", threadId })),
        ).resolves.toBe(false);
        await expect(wasAsked("r1", "a.example")).resolves.toBe("reported");
    });

    it("lets one of two claims made at once for a site win, and records one row", async () => {
        const claim = async () =>
            await harness.action(async (ctx: any) => await ctx.runMutation(claimHumanCheckAsk, { run: "r1", site: "a.example", threadId }));

        const claims = await Promise.all([claim(), claim(), claim()]);
        const rows = await harness.run(async (ctx: any) => await ctx.db.query("browserHumanChecks").collect());

        expect(claims.filter(Boolean)).toHaveLength(1);
        expect(rows).toHaveLength(1);
    });

    it("counts an earlier reply's ask after a hand back only while it is recent", async () => {
        const now = Date.now();
        const askedAt = async (run: string, at: number) =>
            await harness.run(async (ctx: any) => await ctx.db.insert("browserHumanChecks", { askedAt: at, run, site: "a.example", threadId, userId: "u-1" }));
        const wasAskedRecently = async () =>
            await harness.action(
                async (ctx: any) =>
                    await ctx.runQuery(wasHumanCheckAsked, { askedSince: now - HUMAN_CHECK_HAND_BACK_WINDOW_MS, run: "r3", site: "a.example", threadId }),
            );

        await askedAt("r1", now - HUMAN_CHECK_HAND_BACK_WINDOW_MS - 1);

        // An older reply's ask is not what the person handed back, so there is no extra read and no note.
        await expect(wasAskedRecently()).resolves.toBeNull();

        await harness.run(
            async (ctx: any) =>
                await ctx.db.insert("browserHumanChecks", { askedAt: now - 120_000, reported: true, run: "r2", site: "a.example", threadId, userId: "u-1" }),
        );
        await askedAt("r2b", now - 60_000);

        // The latest recent ask is what the person handed back: here a detected check after an earlier report.
        await expect(wasAskedRecently()).resolves.toBe("detected");
    });

    it("stores the thread owner as the row's user whoever asked, so the owner's erasure removes it", async () => {
        // A collaborator's turn runs on the owner's shard; the claim takes no caller id.
        await harness.action(async (ctx: any) => await ctx.runMutation(claimHumanCheckAsk, { run: "collaborator-turn", site: "a.example", threadId }));

        const rows = async () => await harness.run(async (ctx: any) => await ctx.db.query("browserHumanChecks").collect());

        const asked = await rows();

        expect(asked.map((row: { userId: string }) => row.userId)).toEqual(["u-1"]);

        await harness.run(async (ctx: any) => await eraseBrowserDataForUser(ctx, "u-1"));

        await expect(rows()).resolves.toHaveLength(0);
    });

    const insertAsks = async (count: number, userId = "u-1") =>
        await harness.run(async (ctx: any) => {
            for (let index = 0; index < count; index += 1) {
                await ctx.db.insert("browserHumanChecks", { askedAt: index, run: `${userId}-r${String(index)}`, site: "a.example", threadId, userId });
            }
        });
    const askRows = async () => (await harness.run(async (ctx: any) => await ctx.db.query("browserHumanChecks").collect())) as { userId: string }[];

    it("erases more than one batch of asks across calls, then the rest, and leaves another user's", async () => {
        await insertAsks(BATCH * 2 + 5);
        await insertAsks(1, "u-2");

        const rounds: boolean[] = [];

        for (let round = 0; round < 10; round += 1) {
            const { hasMore } = (await harness.run(async (ctx: any) => await eraseBrowserDataForUser(ctx, "u-1"))) as { hasMore: boolean };

            rounds.push(hasMore);

            if (!hasMore) {
                break;
            }
        }

        expect(rounds).toStrictEqual([true, true, false]);
        const left = await askRows();

        expect(left.map((row) => row.userId)).toStrictEqual(["u-2"]);
    });

    it("goes with the thread when it is deleted, a batch per call", async () => {
        await insertAsks(BATCH + 5);

        let rounds = 0;

        for (let done = false; !done && rounds < 10; rounds += 1) {
            const page = (await harness.run(async (ctx: any) => await ctx.runMutation(deleteAllForThreadIdAsync, { threadId }))) as { isDone: boolean };

            done = page.isDone;
        }

        expect(rounds).toBe(2);
        await expect(askRows()).resolves.toHaveLength(0);
    });
});
