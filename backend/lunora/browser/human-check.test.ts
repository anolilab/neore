/**
 * The human-check ladder: detection from what the renderer returns, the one wait, the one ask per site per run, and
 * what the agent hears after the person hands the browser back.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import schema from "../schema";
import { claimHumanCheckAsk, wasHumanCheckAsked } from "./functions";
import {
    detectHumanCheck,
    HUMAN_CHECK_WAIT_MS,
    humanCheckLadder,
    humanCheckSite,
    type LadderDependencies,
    type LadderResult,
    waitUnlessStopped,
} from "./human-check";

/** What the agent hears at each step, as far as these tests read it. */
const CLEARED_NOTE = /cleared on its own.*look at it before you act/su;
const ASKED_NOTE = /asked in the chat.*Do not try to solve or get around it/su;
const ALREADY_ASKED_NOTE = /already asked.*move on, or reach what you need another way/su;
const CLEAR_AFTER_HAND_BACK_NOTE = /handed it back;.*no longer shows: the page looks clear\. Look at it before you act\./su;
/** The hand-back note, then the ask about the other site the read landed on. */
const HAND_BACK_THEN_OTHER_ASK_NOTE = /^The person had control.*other\.example\.org shows a check/su;
const UNKNOWN_AFTER_HAND_BACK_NOTE = /cleared is unknown.*Look at the page before you act/su;

const CHECK_PAGE: LadderResult = { success: true, title: "Just a moment...", url: "https://shop.example.com/item" };
const CLEAR_PAGE: LadderResult = { success: true, title: "Item 42 – Shop", url: "https://shop.example.com/item" };
/** The whole page's text read back, with no check in it: the only look that proves a check is gone after a hand back. */
const CLEAR_EXTRACT: LadderResult = { ...CLEAR_PAGE, content: "Item 42. Add to cart." };
const TEXT_CHECK: LadderResult = { content: "Verifying you are human.", success: true, title: "shop.example.com", url: "https://shop.example.com/" };

/**
 * Dependencies over in-memory sets of sites asked about in this run (`asked`) and in the thread's earlier runs
 * (`earlier`); `looks` are the pages the fresh looks return, in order.
 */
const dependenciesFor = (looks: LadderResult[], asked = new Set<string>(), earlier = new Set<string>()) => {
    const dependencies = {
        claimAsk: vi.fn(async (site: string) => {
            if (asked.has(site)) {
                return false;
            }

            asked.add(site);

            return true;
        }),
        look: vi.fn(async (_kind: "extract" | "screenshot") => looks.shift() ?? CLEAR_PAGE),
        sleep: vi.fn(async (_ms: number) => true),
        wasAsked: vi.fn(async (site: string, scope: "run" | "thread") => asked.has(site) || (scope === "thread" && earlier.has(site))),
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

    it("the agent's own report asks at once, with no wait", async () => {
        const signIn: LadderResult = { success: true, title: "Sign in", url: "https://portal.example.com/login" };
        const { dependencies } = dependenciesFor([]);
        const result = await humanCheckLadder(signIn, dependencies, { reported: true });

        expect(dependencies.sleep).not.toHaveBeenCalled();
        expect(result.humanCheck).toEqual({ site: "portal.example.com", status: "asked" });
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
        expect(result.error).not.toMatch(CLEAR_AFTER_HAND_BACK_NOTE);
        expect(dependencies.claimAsk).not.toHaveBeenCalled();
    });

    it("step 3: a failed action or a failed read after the hand back leaves it unknown, never clear", async () => {
        const failed = { error: "Browser closed", success: false };
        const { dependencies } = dependenciesFor([failed], new Set(["shop.example.com"]));
        const result = await humanCheckLadder({ error: "Timed out", handedBack: true, success: false, url: CLEAR_PAGE.url }, dependencies);

        expect(result.error).toMatch(UNKNOWN_AFTER_HAND_BACK_NOTE);
        expect(result.error).not.toMatch(CLEAR_AFTER_HAND_BACK_NOTE);
        expect(result.success).toBe(false);
    });

    it("step 3: a page still blocked after the hand back is not asked about again", async () => {
        const { dependencies } = dependenciesFor([], new Set(["shop.example.com"]));
        const result = await humanCheckLadder({ ...CHECK_PAGE, handedBack: true }, dependencies);

        expect(result.humanCheck).toEqual({ site: "shop.example.com", status: "already_asked" });
        expect(dependencies.claimAsk).not.toHaveBeenCalled();
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

    it("step 1: a person who took control during the wait and handed back an empty browser or another site is not asked", async () => {
        for (const look of [
            { content: "", success: true, title: "", url: "about:blank" },
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
            await harness.action(async (ctx: any) => await ctx.runMutation(claimHumanCheckAsk, { run, site, threadId, userId: "u-1" }));
        const wasAsked = async (run: string, site: string) =>
            await harness.action(async (ctx: any) => await ctx.runQuery(wasHumanCheckAsked, { run, site, threadId }));

        await expect(wasAsked("r1", "a.example")).resolves.toBe(false);
        await expect(claim("r1", "a.example")).resolves.toBe(true);
        await expect(claim("r1", "a.example")).resolves.toBe(false);
        await expect(wasAsked("r1", "a.example")).resolves.toBe(true);
        await expect(claim("r1", "b.example")).resolves.toBe(true);
        await expect(claim("r2", "a.example")).resolves.toBe(true);
    });

    it("lets one of two claims made at once for a site win, and records one row", async () => {
        const claim = async () =>
            await harness.action(async (ctx: any) => await ctx.runMutation(claimHumanCheckAsk, { run: "r1", site: "a.example", threadId, userId: "u-1" }));

        const claims = await Promise.all([claim(), claim(), claim()]);
        const rows = await harness.run(async (ctx: any) => await ctx.db.query("browserHumanChecks").collect());

        expect(claims.filter(Boolean)).toHaveLength(1);
        expect(rows).toHaveLength(1);
    });
});
