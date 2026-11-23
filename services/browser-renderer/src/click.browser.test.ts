import { createHash } from "node:crypto";

import type { Browser, Page } from "playwright";
import { chromium } from "playwright";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { readTarget, TARGET_READ_OPTIONS } from "./target-read";

/** A SHA-256 digest in hex. */
const HEX_DIGEST = /^[0-9a-f]{64}$/u;

/** A page with the given markup, served at an address (a read resolves URLs against the page's own, so `about:blank` will not do). */
const pageWith = async (page: Page, markup: string, path = "/cart") => {
    await page.route("https://shop.example/**", async (route) => {
        await route.fulfill({
            body: `<!doctype html><html><head><title>Shop</title></head><body>${markup}</body></html>`,
            contentType: "text/html",
        });
    });
    await page.goto(`https://shop.example${path}`, { waitUntil: "domcontentloaded" });
};

/** Whether the page's click handler ran. */
const wasClicked = async (page: Page) => await page.evaluate(() => (globalThis as unknown as { clicked?: boolean }).clicked === true);

describe("readTarget in a page", () => {
    let browser: Browser;
    let page: Page;

    beforeAll(async () => {
        browser = await chromium.launch();
    });

    beforeEach(async () => {
        page = await browser.newPage();
    });

    afterAll(async () => {
        await browser.close();
    });

    it.each([0, 1, 40, 55, 56, 63, 64, 120, 300])(
        "the fingerprint is the SHA-256 of the canonical string, computed in the page (a label of %i characters)",
        async (length) => {
            // The label mixes in multi-byte characters, so the digest is over UTF-8 bytes, not over characters.
            await pageWith(page, `<button id="pay">${"ä€".repeat(length)}</button>`);
            const element = await page.$("#pay");

            const read = await element!.evaluate(readTarget, TARGET_READ_OPTIONS);

            expect(read.target).toBe(createHash("sha256").update(read.canonical, "utf8").digest("hex"));
            expect(read.clicked).toBe(false);
            expect(read.refused).toBeUndefined();
        },
    );

    it("a read with no click dispatches nothing, even on a hidden control", async () => {
        await pageWith(page, `<button id="pay" style="display: none" onclick="window.clicked = true">Pay now</button>`);
        const element = await page.$("#pay");

        const read = await element!.evaluate(readTarget, TARGET_READ_OPTIONS);

        expect(read.refused).toBeUndefined();
        expect(read.clicked).toBe(false);
        expect(await wasClicked(page)).toBe(false);
    });

    it("a click given its own target runs on the element, once the check passes", async () => {
        await pageWith(page, `<button id="pay" onclick="window.clicked = true">Pay now</button>`);
        const element = await page.$("#pay");
        const seen = await element!.evaluate(readTarget, TARGET_READ_OPTIONS);

        const read = await element!.evaluate(readTarget, { ...TARGET_READ_OPTIONS, click: true, expect: seen.target });

        expect(read.clicked).toBe(true);
        expect(read.refused).toBeUndefined();
        expect(await wasClicked(page)).toBe(true);
    });

    it("a click is refused and nothing is clicked when the element changed after it was shown", async () => {
        await pageWith(page, `<button id="pay" onclick="window.clicked = true">Pay now</button>`);
        const element = await page.$("#pay");
        const seen = await element!.evaluate(readTarget, TARGET_READ_OPTIONS);

        await element!.evaluate((control) => {
            control.replaceChildren("Pay now, 499 EUR per month");
        });
        const read = await element!.evaluate(readTarget, { ...TARGET_READ_OPTIONS, click: true, expect: seen.target });

        expect(read.refused).toBe("changed");
        expect(read.clicked).toBe(false);
        expect(await wasClicked(page)).toBe(false);
    });

    it("a disabled control is refused and nothing is clicked", async () => {
        await pageWith(page, `<button id="pay" disabled onclick="window.clicked = true">Pay now</button>`);
        const element = await page.$("#pay");
        const seen = await element!.evaluate(readTarget, TARGET_READ_OPTIONS);

        const read = await element!.evaluate(readTarget, { ...TARGET_READ_OPTIONS, click: true, expect: seen.target });

        expect(read.refused).toBe("disabled");
        expect(await wasClicked(page)).toBe(false);
    });

    it("an aria-disabled control is refused and nothing is clicked", async () => {
        await pageWith(page, `<div id="pay" role="button" aria-disabled="true" onclick="window.clicked = true">Pay now</div>`);
        const element = await page.$("#pay");
        const seen = await element!.evaluate(readTarget, TARGET_READ_OPTIONS);

        const read = await element!.evaluate(readTarget, { ...TARGET_READ_OPTIONS, click: true, expect: seen.target });

        expect(read.refused).toBe("disabled");
        expect(await wasClicked(page)).toBe(false);
    });

    it("a hidden control is refused and nothing is clicked", async () => {
        await pageWith(page, `<button id="pay" onclick="window.clicked = true">Pay now</button>`);
        const element = await page.$("#pay");
        const seen = await element!.evaluate(readTarget, TARGET_READ_OPTIONS);

        await element!.evaluate((control) => {
            control.setAttribute("style", "display: none");
        });
        const read = await element!.evaluate(readTarget, { ...TARGET_READ_OPTIONS, click: true, expect: seen.target });

        expect(read.refused).toBe("hidden");
        expect(await wasClicked(page)).toBe(false);
    });

    it("an arrow named by a labelled image's alt text reads as that name", async () => {
        await pageWith(page, `<button id="arrow" aria-labelledby="buy"><img id="buy" alt="Buy now" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="></button>`);
        const element = await page.$("#arrow");

        const read = await element!.evaluate(readTarget, TARGET_READ_OPTIONS);

        expect(read.label).toContain("Buy now");
    });

    it("a form's destination is the browser's resolved action, so a changed base moves the fingerprint", async () => {
        await pageWith(page, `<base href="https://shop.example/a/"><form action="pay"><button id="go" type="submit">Go</button></form>`);
        const element = await page.$("#go");
        const before = await element!.evaluate(readTarget, TARGET_READ_OPTIONS);

        await page.evaluate(() => {
            document.querySelector("base")!.setAttribute("href", "https://other.example/b/");
        });
        const after = await element!.evaluate(readTarget, TARGET_READ_OPTIONS);

        expect(after.target).not.toBe(before.target);
    });

    it("a click whose page moves the form destination in its own click handler is refused, and nothing is submitted", async () => {
        await pageWith(page, `<form id="order" action="/cart/confirm"><button id="pay" type="submit">Pay now</button></form>`);
        const element = await page.$("#pay");
        const seen = await element!.evaluate(readTarget, TARGET_READ_OPTIONS);

        // The page moves its form's destination on the click, after the check and before the browser would submit.
        await page.evaluate(() => {
            document.addEventListener("click", () => {
                document.querySelector("form")!.setAttribute("action", "/elsewhere");
            });
        });
        const read = await element!.evaluate(readTarget, { ...TARGET_READ_OPTIONS, click: true, expect: seen.target });

        // The click ran (its handlers did), and the browser stopped the submission: a `moved` refusal, not a changed target.
        expect(read.refused).toBe("moved");
        expect(read.clicked).toBe(true);
        // No event marks a navigation that never starts: a short wait is how the absence shows.
        // eslint-disable-next-line sonarjs/no-fixed-wait-in-tests
        await page.waitForTimeout(300);
        expect(page.url()).toBe("https://shop.example/cart");
    });

    it("a destination moved by a handler that stops the click's propagation does not move the approved submission", async () => {
        await pageWith(page, `<form id="order" action="/cart/confirm"><button id="pay" type="submit">Pay now</button></form>`);
        const element = await page.$("#pay");
        const seen = await element!.evaluate(readTarget, TARGET_READ_OPTIONS);

        // The handler stops the click's propagation, so no bubbling listener sees the click: the submit boundary still does.
        await page.evaluate(() => {
            document.querySelector("#pay")!.addEventListener("click", (event) => {
                event.stopPropagation();
                document.querySelector("form")!.setAttribute("action", "/elsewhere");
            });
        });
        const read = await element!.evaluate(readTarget, { ...TARGET_READ_OPTIONS, click: true, expect: seen.target });

        expect(read.refused).toBeUndefined();
        await page.waitForURL("**/cart/confirm**", { timeout: 3000 });
        expect(page.url()).toContain("/cart/confirm");
    });

    it("a purchase phrase appended to a label already at the cap changes the target", async () => {
        // The label is exactly the cap, with no text of its own, so nothing is cut yet.
        await pageWith(page, `<button id="icon" aria-label="${"a".repeat(15_000)}"></button>`);
        const element = await page.$("#icon");
        const before = await element!.evaluate(readTarget, TARGET_READ_OPTIONS);

        await element!.evaluate((control) => {
            control.setAttribute("aria-label", `${control.getAttribute("aria-label") ?? ""} Buy now`);
        });
        const after = await element!.evaluate(readTarget, TARGET_READ_OPTIONS);

        expect(before.labelTruncated).toBe(false);
        expect(after.labelTruncated).toBe(true);
        expect(after.target).not.toBe(before.target);
    });

    it("a link whose destination a handler moves, with its propagation stopped, is refused and does not navigate", async () => {
        await pageWith(page, `<a id="go" href="/cart/confirm">Buy now</a>`);
        const element = await page.$("#go");
        const seen = await element!.evaluate(readTarget, TARGET_READ_OPTIONS);

        await page.evaluate(() => {
            document.querySelector("#go")!.addEventListener("click", (event) => {
                event.stopPropagation();
                document.querySelector("#go")!.setAttribute("href", "/elsewhere");
            });
        });
        const read = await element!.evaluate(readTarget, { ...TARGET_READ_OPTIONS, click: true, expect: seen.target });

        expect(read.refused).toBe("moved");
        // No event marks a navigation that never starts: a short wait is how the absence shows.
        // eslint-disable-next-line sonarjs/no-fixed-wait-in-tests
        await page.waitForTimeout(300);
        expect(page.url()).toBe("https://shop.example/cart");
    });

    it("a link whose destination does not move navigates as it always did", async () => {
        await pageWith(page, `<a id="go" href="/cart/confirm">Buy now</a>`);
        const element = await page.$("#go");
        const seen = await element!.evaluate(readTarget, TARGET_READ_OPTIONS);

        const read = await element!.evaluate(readTarget, { ...TARGET_READ_OPTIONS, click: true, expect: seen.target });

        expect(read.refused).toBeUndefined();
        await page.waitForURL("https://shop.example/cart/confirm");
    });

    it("a mouse-down handler responds to a click, and the click still runs", async () => {
        await pageWith(page, `<button id="pay" onmousedown="window.pressed = true" onclick="window.clicked = true">Continue</button>`);
        const element = await page.$("#pay");
        const seen = await element!.evaluate(readTarget, TARGET_READ_OPTIONS);

        const read = await element!.evaluate(readTarget, { ...TARGET_READ_OPTIONS, click: true, expect: seen.target });

        expect(read.clicked).toBe(true);
        expect(await page.evaluate(() => (globalThis as unknown as { pressed?: boolean }).pressed === true)).toBe(true);
        expect(await wasClicked(page)).toBe(true);
    });

    it("a pointer handler that changes the label before the click stops the click, so an unread label is never clicked", async () => {
        await pageWith(page, `<button id="pay" onpointerdown="this.textContent = 'Buy now'" onclick="window.clicked = true">Continue</button>`);
        const element = await page.$("#pay");
        const seen = await element!.evaluate(readTarget, TARGET_READ_OPTIONS);

        const read = await element!.evaluate(readTarget, { ...TARGET_READ_OPTIONS, click: true, expect: seen.target });

        expect(read.refused).toBe("pressed");
        expect(read.clicked).toBe(false);
        expect(await wasClicked(page)).toBe(false);
    });

    it("a label changed in a sibling's text during the press is refused, though the selected element did not change", async () => {
        await pageWith(
            page,
            `<button id="pay" onpointerdown="document.getElementById('label').textContent = 'Buy now'" onclick="window.clicked = true"><span id="icon">x</span><span id="label">Continue</span></button>`,
        );
        const element = await page.$("#icon");
        const seen = await element!.evaluate(readTarget, TARGET_READ_OPTIONS);

        const read = await element!.evaluate(readTarget, { ...TARGET_READ_OPTIONS, click: true, expect: seen.target });

        expect(read.refused).toBe("pressed");
        expect(read.clicked).toBe(false);
        expect(await wasClicked(page)).toBe(false);
    });

    it("a dialog that covers an approved button refuses the click, and nothing is clicked", async () => {
        await pageWith(
            page,
            `<button id="pay" style="position: absolute; top: 40px; left: 40px; width: 160px; height: 48px" onclick="window.clicked = true">Pay now</button><div id="modal" style="position: fixed; inset: 0; background: rgba(0,0,0,0.3)"></div>`,
        );
        const element = await page.$("#pay");
        const seen = await element!.evaluate(readTarget, TARGET_READ_OPTIONS);

        const read = await element!.evaluate(readTarget, { ...TARGET_READ_OPTIONS, click: true, expect: seen.target });

        expect(read.refused).toBe("covered");
        expect(read.clicked).toBe(false);
        expect(await wasClicked(page)).toBe(false);
    });

    it("a submit control moved to another form during the press is refused", async () => {
        await pageWith(
            page,
            `<form id="a" action="/cart/confirm"></form><form id="b" action="/elsewhere"><button id="pay" type="submit" onpointerdown="this.setAttribute('form', 'a')">Pay now</button></form>`,
        );
        const element = await page.$("#pay");
        const seen = await element!.evaluate(readTarget, TARGET_READ_OPTIONS);

        const read = await element!.evaluate(readTarget, { ...TARGET_READ_OPTIONS, click: true, expect: seen.target });

        expect(read.refused).toBe("pressed");
        expect(read.clicked).toBe(false);
    });

    it("a press handler that disables the control stops the click, though the fingerprint did not change", async () => {
        await pageWith(page, `<button id="pay" onpointerdown="this.disabled = true" onclick="window.clicked = true">Continue</button>`);
        const element = await page.$("#pay");
        const seen = await element!.evaluate(readTarget, TARGET_READ_OPTIONS);

        const read = await element!.evaluate(readTarget, { ...TARGET_READ_OPTIONS, click: true, expect: seen.target });

        expect(read.refused).toBe("disabled");
        expect(read.clicked).toBe(false);
        expect(await wasClicked(page)).toBe(false);
    });

    it("generated text past the cap truncates the read, even when the repeated text was deduplicated", async () => {
        const repeated = "a".repeat(8000);

        await pageWith(
            page,
            `<style>.a::before { content: "${repeated}" } .b::before { content: "Buy now" }</style><button id="go"><span class="a"></span><span class="a"></span><span class="b"></span></button>`,
        );
        const element = await page.$("#go");

        const read = await element!.evaluate(readTarget, TARGET_READ_OPTIONS);

        expect(read.labelTruncated).toBe(true);
    });

    it("a label reference to a subtree past the budget truncates the read, so the gate asks", async () => {
        await pageWith(page, `<button id="go" aria-labelledby="big"><span>x</span></button><div id="big">${"<span>a</span>".repeat(2500)}</div>`);
        const element = await page.$("#go");

        const read = await element!.evaluate(readTarget, TARGET_READ_OPTIONS);

        expect(read.labelTruncated).toBe(true);
    });

    it("a control inside an invisible (opacity 0) parent is refused as hidden, and nothing is clicked", async () => {
        await pageWith(page, `<div style="opacity: 0"><button id="pay" onclick="window.clicked = true">Pay now</button></div>`);
        const element = await page.$("#pay");
        const seen = await element!.evaluate(readTarget, TARGET_READ_OPTIONS);

        const read = await element!.evaluate(readTarget, { ...TARGET_READ_OPTIONS, click: true, expect: seen.target, strict: true });

        expect(read.refused).toBe("hidden");
        expect(await wasClicked(page)).toBe(false);
    });

    it("a press handler that makes the parent transparent stops the click, though the fingerprint did not change", async () => {
        await pageWith(
            page,
            `<div id="wrap"><button id="pay" onpointerdown="document.getElementById('wrap').style.opacity = '0'" onclick="window.clicked = true">Continue</button></div>`,
        );
        const element = await page.$("#pay");
        const seen = await element!.evaluate(readTarget, TARGET_READ_OPTIONS);

        const read = await element!.evaluate(readTarget, { ...TARGET_READ_OPTIONS, click: true, expect: seen.target, strict: true });

        expect(read.refused).toBe("hidden");
        expect(read.clicked).toBe(false);
        expect(await wasClicked(page)).toBe(false);
    });

    it("an invisible (opacity 0) control is refused as hidden, and nothing is clicked", async () => {
        await pageWith(page, `<button id="pay" style="opacity: 0" onclick="window.clicked = true">Pay now</button>`);
        const element = await page.$("#pay");
        const seen = await element!.evaluate(readTarget, TARGET_READ_OPTIONS);

        const read = await element!.evaluate(readTarget, { ...TARGET_READ_OPTIONS, click: true, expect: seen.target, strict: true });

        expect(read.refused).toBe("hidden");
        expect(await wasClicked(page)).toBe(false);
    });

    it("a click on a child of a disabled button is refused and nothing is clicked", async () => {
        await pageWith(page, `<button id="buy" disabled><span id="label" onclick="window.clicked = true">Buy</span></button>`);
        const element = await page.$("#label");

        const read = await element!.evaluate(readTarget, { ...TARGET_READ_OPTIONS, click: true });

        expect(read.refused).toBe("disabled");
        expect(await wasClicked(page)).toBe(false);
    });

    it("a form with a malformed frame address still reads its target", async () => {
        await pageWith(page, `<form action="/order"><iframe src="http://["></iframe><button id="go" type="submit">Go</button></form>`);
        const element = await page.$("#go");

        const read = await element!.evaluate(readTarget, TARGET_READ_OPTIONS);

        expect(read.target).toHaveLength(64);
        expect(read.target).toMatch(HEX_DIGEST);
        expect(read.refused).toBeUndefined();
    });

    it("an encoded checkout route counts as a checkout page", async () => {
        await pageWith(page, `<button id="confirm">Confirm</button>`, "/checkout%2Fconfirm");
        const element = await page.$("#confirm");

        const read = await element!.evaluate(readTarget, TARGET_READ_OPTIONS);

        expect(read.checkout).toBe(true);
    });

    it("a click whose destination does not move submits as it always did", async () => {
        await pageWith(page, `<form id="order" action="/cart/confirm"><button id="pay" type="submit">Pay now</button></form>`);
        await page.evaluate(() => {
            document.querySelector("form")!.addEventListener("submit", (event) => {
                document.body.dataset.submitted = "true";
                event.preventDefault();
            });
        });
        const element = await page.$("#pay");
        const seen = await element!.evaluate(readTarget, TARGET_READ_OPTIONS);

        const read = await element!.evaluate(readTarget, { ...TARGET_READ_OPTIONS, click: true, expect: seen.target });

        expect(read.refused).toBeUndefined();
        expect(read.clicked).toBe(true);
        expect(await page.evaluate(() => document.body.dataset.submitted === "true")).toBe(true);
    });
    it("an ordinary click on a styled checkbox (input at opacity 0) still clicks: opacity alone does not refuse it", async () => {
        await pageWith(page, `<input id="box" type="checkbox" style="opacity: 0" onclick="window.clicked = true">`);
        const element = await page.$("#box");
        const seen = await element!.evaluate(readTarget, TARGET_READ_OPTIONS);

        const read = await element!.evaluate(readTarget, { ...TARGET_READ_OPTIONS, click: true, expect: seen.target });

        expect(read.refused).toBeUndefined();
        expect(await wasClicked(page)).toBe(true);
    });
    it("a page submit handler that moves the destination does not redirect an approved submission", async () => {
        await pageWith(
            page,
            `<form id="order" action="/cart/confirm"><button id="pay" type="submit">Pay now</button></form><script>document.addEventListener("submit", () => { document.getElementById("order").setAttribute("action", "/elsewhere"); });</script>`,
        );
        const element = await page.$("#pay");
        const seen = await element!.evaluate(readTarget, TARGET_READ_OPTIONS);

        const read = await element!.evaluate(readTarget, { ...TARGET_READ_OPTIONS, click: true, expect: seen.target });

        expect(read.refused).toBeUndefined();
        await page.waitForURL("**/cart/confirm**", { timeout: 3000 });
        expect(page.url()).not.toContain("/elsewhere");
    });

    it("a page handler that moves the submitter's own action and method does not change an approved submission", async () => {
        await pageWith(
            page,
            `<form id="order" action="/cart/confirm" method="post"><input name="qty" value="2"><button id="pay" type="submit" formaction="/cart/pay" formmethod="get">Pay now</button></form><script>document.addEventListener("submit", () => { const pay = document.getElementById("pay"); pay.setAttribute("formaction", "/elsewhere"); pay.setAttribute("formmethod", "post"); });</script>`,
        );
        const element = await page.$("#pay");
        const seen = await element!.evaluate(readTarget, TARGET_READ_OPTIONS);

        const read = await element!.evaluate(readTarget, { ...TARGET_READ_OPTIONS, click: true, expect: seen.target });

        expect(read.refused).toBeUndefined();
        // The approved submitter sends a GET to its own address: the query carries the field, and nothing was posted elsewhere.
        await page.waitForURL("**/cart/pay?qty=2", { timeout: 3000 });
        expect(page.url()).not.toContain("/elsewhere");
    });

    it("a submit listener a click handler adds, after the renderer's, can still cancel an approved submission", async () => {
        await pageWith(
            page,
            `<form id="order" action="/cart/confirm"><button id="pay" type="submit" onclick="window.addEventListener('submit', (event) => { event.preventDefault(); document.body.dataset.cancelled = 'true'; })">Pay now</button></form>`,
        );
        const element = await page.$("#pay");
        const seen = await element!.evaluate(readTarget, TARGET_READ_OPTIONS);

        const read = await element!.evaluate(readTarget, { ...TARGET_READ_OPTIONS, click: true, expect: seen.target });

        expect(read.clicked).toBe(true);
        await page.waitForFunction(() => document.body.dataset.cancelled === "true", undefined, { timeout: 3000 });
        // A submission the listener did not cancel would start within the same task; a short beat lets a navigation show itself.
        await page.evaluate(async () => {
            await new Promise((resolve) => {
                setTimeout(resolve, 300);
            });
        });
        expect(page.url()).toContain("/cart");
        expect(page.url()).not.toContain("/cart/confirm");
    });

    it("reports a bare Subscribe name part, even when the joined name is longer, and not a longer subscribe label", async () => {
        await pageWith(
            page,
            `<button id="join" aria-label="Subscribe" title="Monthly plan">→</button><button id="news" aria-label="Subscribe to our newsletter">→</button>`,
        );
        const joined = await (await page.$("#join"))!.evaluate(readTarget, TARGET_READ_OPTIONS);
        const newsletter = await (await page.$("#news"))!.evaluate(readTarget, TARGET_READ_OPTIONS);

        expect(joined.subscribeLike).toBe(true);
        expect(newsletter.subscribeLike).toBe(false);
    });

    it("a label's click submits through its own button, and a page handler's move of that button's destination does not redirect it", async () => {
        await pageWith(
            page,
            `<form id="order" action="/cart/confirm"><label id="pay-label" for="pay">Pay now</label><button id="pay" type="submit" formaction="/cart/pay">Pay</button></form><script>document.addEventListener("submit", () => { document.getElementById("pay").setAttribute("formaction", "/elsewhere"); });</script>`,
        );
        const label = await page.$("#pay-label");
        const seen = await label!.evaluate(readTarget, TARGET_READ_OPTIONS);

        const read = await label!.evaluate(readTarget, { ...TARGET_READ_OPTIONS, click: true, expect: seen.target });

        expect(read.refused).toBeUndefined();
        await page.waitForURL("**/cart/pay**", { timeout: 3000 });
        expect(page.url()).not.toContain("/elsewhere");
    });

    it("a click on a span inside an approved button submits through the button, and a handler that moves its destination and stops propagation does not redirect it", async () => {
        await pageWith(
            page,
            `<form id="order" action="/cart/confirm"><button id="pay" type="submit" formaction="/cart/pay"><span id="inner">Pay now</span></button></form><script>document.getElementById("pay").addEventListener("click", (event) => { event.stopPropagation(); document.getElementById("pay").setAttribute("formaction", "/elsewhere"); });</script>`,
        );
        const inner = await page.$("#inner");
        const seen = await inner!.evaluate(readTarget, TARGET_READ_OPTIONS);

        const read = await inner!.evaluate(readTarget, { ...TARGET_READ_OPTIONS, click: true, expect: seen.target });

        expect(read.refused).toBeUndefined();
        await page.waitForURL("**/cart/pay**", { timeout: 3000 });
        expect(page.url()).not.toContain("/elsewhere");
    });

    it("a label whose page re-points its for attribute after the approval read is refused, and nothing is submitted", async () => {
        await pageWith(
            page,
            `<form id="order" action="/cart/confirm"><label id="pay-label" for="pay">Pay now</label><button id="pay" type="submit" formaction="/cart/pay">Pay</button><button id="other" type="submit" formaction="/cart/other">Other</button></form>`,
        );
        const label = await page.$("#pay-label");
        const seen = await label!.evaluate(readTarget, TARGET_READ_OPTIONS);

        await label!.evaluate((node) => {
            node.setAttribute("for", "other");
        });
        const read = await label!.evaluate(readTarget, { ...TARGET_READ_OPTIONS, click: true, expect: seen.target });

        expect(read.clicked).toBe(false);
        expect(read.refused).toBe("changed");
        // A navigation would start within the same task; a short beat lets it show itself.
        await page.evaluate(async () => {
            await new Promise((resolve) => {
                setTimeout(resolve, 300);
            });
        });
        expect(page.url()).not.toContain("/cart/other");
        expect(page.url()).not.toContain("/cart/pay");
    });

    it("a label whose submit button is moved to another form after the approval read is refused, and nothing is submitted", async () => {
        await pageWith(
            page,
            `<form id="a" action="/cart/confirm"></form><form id="b" action="/cart/other"></form><label id="pay-label" for="pay">Pay now</label><button id="pay" type="submit" form="a">Pay</button>`,
        );
        const label = await page.$("#pay-label");
        const seen = await label!.evaluate(readTarget, TARGET_READ_OPTIONS);

        await page.evaluate(() => {
            document.querySelector("#pay")!.setAttribute("form", "b");
        });
        const read = await label!.evaluate(readTarget, { ...TARGET_READ_OPTIONS, click: true, expect: seen.target });

        expect(read.clicked).toBe(false);
        expect(read.refused).toBe("changed");
    });

    it("a label whose submit button's value changes after the approval read is refused, and nothing is submitted", async () => {
        await pageWith(
            page,
            `<form id="a" action="/cart/confirm"><label id="pay-label" for="pay">Pay now</label><button id="pay" type="submit" value="one">Pay</button></form>`,
        );
        const label = await page.$("#pay-label");
        const seen = await label!.evaluate(readTarget, TARGET_READ_OPTIONS);

        await page.evaluate(() => {
            document.querySelector("#pay")!.setAttribute("value", "two");
        });
        const read = await label!.evaluate(readTarget, { ...TARGET_READ_OPTIONS, click: true, expect: seen.target });

        expect(read.clicked).toBe(false);
        expect(read.refused).toBe("changed");
    });

    it("a label whose submit button moves to another form with the same action after the approval read is refused", async () => {
        await pageWith(
            page,
            `<form id="a" action="/cart/confirm"></form><form id="b" action="/cart/confirm"></form><label id="pay-label" for="pay">Pay now</label><button id="pay" type="submit" form="a">Pay</button>`,
        );
        const label = await page.$("#pay-label");
        const seen = await label!.evaluate(readTarget, TARGET_READ_OPTIONS);

        await page.evaluate(() => {
            document.querySelector("#pay")!.setAttribute("form", "b");
        });
        const read = await label!.evaluate(readTarget, { ...TARGET_READ_OPTIONS, click: true, expect: seen.target });

        expect(read.clicked).toBe(false);
        expect(read.refused).toBe("changed");
    });

    it("an approved image button submits its coordinates, and a named submit button submits its name and value", async () => {
        const gif = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

        await pageWith(
            page,
            `<form id="order" action="/cart/confirm"><input id="buy" type="image" name="buy" alt="Buy" src="${gif}"></form><form id="second" action="/cart/second"><button id="intent" type="submit" name="intent" value="confirm">Confirm</button></form>`,
        );
        const urls: string[] = [];

        page.on("request", (request) => {
            urls.push(request.url());
        });
        const image = await page.$("#buy");
        const seen = await image!.evaluate(readTarget, TARGET_READ_OPTIONS);

        const read = await image!.evaluate(readTarget, { ...TARGET_READ_OPTIONS, click: true, expect: seen.target });

        expect(read.refused).toBeUndefined();
        await page.waitForURL("**/cart/confirm**", { timeout: 3000 });
        expect(page.url()).toContain("buy.x=");
        expect(page.url()).toContain("buy.y=");

        const intent = await page.$("#intent");
        const named = await intent!.evaluate(readTarget, TARGET_READ_OPTIONS);

        const namedClick = await intent!.evaluate(readTarget, { ...TARGET_READ_OPTIONS, click: true, expect: named.target });

        expect(namedClick.refused).toBeUndefined();
        expect(namedClick.clicked).toBe(true);
        await page.waitForURL("**/cart/second**", { timeout: 3000 });
        expect(page.url()).toContain("intent=confirm");
        expect(urls.some((url) => url.includes("intent=confirm"))).toBe(true);
    });

    it("a regrouped name that keeps the joined text but makes a bare Subscribe changes the fingerprint", async () => {
        await pageWith(page, `<button id="plan" aria-label="Subscribe" title="Monthly plan">→</button>`);
        const element = await page.$("#plan");
        const before = await element!.evaluate(readTarget, TARGET_READ_OPTIONS);

        // The name is regrouped into one source: a bare Subscribe is no longer one of its parts, so the decision changes.
        await element!.evaluate((node) => {
            node.setAttribute("aria-label", "Subscribe Monthly plan");
            node.removeAttribute("title");
        });
        const after = await element!.evaluate(readTarget, TARGET_READ_OPTIONS);

        expect(before.subscribeLike).toBe(true);
        expect(after.subscribeLike).toBe(false);
        expect(after.target).not.toBe(before.target);
    });
});
