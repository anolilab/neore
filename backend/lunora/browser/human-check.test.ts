/**
 * The human-check ladder: detection from what the renderer returns, the one wait, the one ask per site per run, and
 * what the agent hears after the person hands the browser back.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import schema from "../schema";
import { claimHumanCheckAsk, wasHumanCheckAsked } from "./functions";
import { detectHumanCheck, HUMAN_CHECK_WAIT_MS, humanCheckLadder, humanCheckSite, type LadderDependencies, type LadderResult } from "./human-check";

/** What the agent hears at each step, as far as these tests read it. */
const CLEARED_NOTE = /cleared on its own.*look at it before you act/su;
const ASKED_NOTE = /asked in the chat.*Do not try to solve or get around it/su;
const ALREADY_ASKED_NOTE = /already asked.*move on, or reach what you need another way/su;
const CLEAR_AFTER_HAND_BACK_NOTE = /handed it back;.*no longer shows: the page looks clear\. Look at it before you act\./su;

const CHECK_PAGE: LadderResult = { success: true, title: "Just a moment...", url: "https://shop.example.com/item" };
const CLEAR_PAGE: LadderResult = { success: true, title: "Item 42 – Shop", url: "https://shop.example.com/item" };

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
        sleep: vi.fn(async () => undefined),
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

    it("step 1: a check found in the page's text is looked for in the text again", async () => {
        const blocked: LadderResult = { content: "Verifying you are human.", success: true, title: "shop.example.com", url: "https://shop.example.com/" };
        const { dependencies } = dependenciesFor([blocked]);
        const result = await humanCheckLadder(blocked, dependencies, { readContent: true });

        expect(dependencies.look).toHaveBeenCalledExactlyOnceWith("extract");
        expect(result.humanCheck).toEqual({ site: "shop.example.com", status: "asked" });
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

    it("step 3: after the hand back, a clear page tells the agent it is clear and to look first, also in the next run", async () => {
        const { dependencies } = dependenciesFor([], new Set(), new Set(["shop.example.com"]));
        const result = await humanCheckLadder(
            { ...CLEAR_PAGE, error: "The person had control of the browser and handed it back;", handedBack: true },
            dependencies,
        );

        expect(result.humanCheck).toBeUndefined();
        expect(result.error).toMatch(CLEAR_AFTER_HAND_BACK_NOTE);
    });

    it("step 3: a page still blocked after the hand back is not asked about again", async () => {
        const { dependencies } = dependenciesFor([], new Set(["shop.example.com"]));
        const result = await humanCheckLadder({ ...CHECK_PAGE, handedBack: true }, dependencies);

        expect(result.humanCheck).toEqual({ site: "shop.example.com", status: "already_asked" });
        expect(dependencies.claimAsk).not.toHaveBeenCalled();
    });

    it("step 3: a hand back on a site nobody was asked about adds nothing", async () => {
        const { dependencies } = dependenciesFor([]);
        const handed = { ...CLEAR_PAGE, handedBack: true };

        await expect(humanCheckLadder(handed, dependencies)).resolves.toBe(handed);
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
});
