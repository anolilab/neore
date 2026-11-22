import { createHash } from "node:crypto";

import type { Browser, Page } from "playwright";
import { chromium } from "playwright";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { readTarget, TARGET_READ_OPTIONS } from "./target-read";

/** A page with the given markup, served at an address (a read resolves URLs against the page's own, so `about:blank` will not do). */
const pageWith = async (page: Page, markup: string) => {
    await page.route("https://shop.example/**", async (route) => {
        await route.fulfill({
            body: `<!doctype html><html><head><title>Shop</title></head><body>${markup}</body></html>`,
            contentType: "text/html",
        });
    });
    await page.goto("https://shop.example/cart", { waitUntil: "domcontentloaded" });
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
        await page.evaluate(() => {
            document.querySelector("form")!.addEventListener("submit", (event) => {
                document.body.dataset.submitted = "true";
                event.preventDefault();
            });
        });
        const element = await page.$("#pay");
        const seen = await element!.evaluate(readTarget, TARGET_READ_OPTIONS);

        // The page moves its form's destination on the click, after the check and before the browser would submit.
        await page.evaluate(() => {
            document.addEventListener("click", () => {
                document.querySelector("form")!.setAttribute("action", "/elsewhere");
            });
        });
        const read = await element!.evaluate(readTarget, { ...TARGET_READ_OPTIONS, click: true, expect: seen.target });

        expect(read.refused).toBe("changed");
        expect(read.clicked).toBe(false);
        expect(await page.evaluate(() => document.body.dataset.submitted === "true")).toBe(false);
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
});
