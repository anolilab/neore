import { expect, test } from "@playwright/test";

import { PUBLIC_PATHS } from "./fixtures";

const AUTH_URL_RE = /\/auth\//;

test.describe("Models page (public)", () => {
    test.beforeEach(async ({ page }) => {
        await page.goto(PUBLIC_PATHS.models);
    });

    test("renders the hero heading", async ({ page }) => {
        await expect(page.getByText("Every model.").first()).toBeVisible();
    });

    test("lists the model category sections", async ({ page }) => {
        // Headings, not bare text: "Image generation" also appears inside model
        // descriptions, and a loose getByText matches three nodes and fails
        // strict mode.
        await expect(page.getByRole("heading", { name: "Text & chat" })).toBeVisible();
        await expect(page.getByRole("heading", { name: "Image generation" })).toBeVisible();
        await expect(page.getByRole("heading", { name: "Video generation" })).toBeVisible();
    });

    test("offers a sign-up call to action", async ({ page }) => {
        await expect(page.getByText("Try it free").first()).toBeVisible();
    });

    test("renders the navbar", async ({ page }) => {
        await expect(page.getByRole("navigation").first()).toBeVisible();
    });
});

test.describe("Landing page", () => {
    /**
     * `/` was gated on `context.isAuthenticated` in 29c67458, so every anonymous
     * visitor — and every crawler — got a 307 to /auth/sign-in while
     * `sitemap.xml` advertised the same URL at priority 1.0.
     *
     * These two tests are the pair that keeps it honest: the page must answer
     * anonymously, and it must still carry the SEO markup that is the whole
     * reason for it being public. Re-gating the route fails the first; stripping
     * the metadata fails the second.
     */
    test("is reachable without signing in", async ({ page }) => {
        const response = await page.goto(PUBLIC_PATHS.landing);

        expect(response?.status()).toBe(200);
        await expect(page).not.toHaveURL(AUTH_URL_RE);
        await expect(page.getByText("Try it free").first()).toBeVisible();
    });

    test("serves the metadata that sitemap.xml promises crawlers", async ({ page, request }) => {
        await page.goto(PUBLIC_PATHS.landing);

        await expect(page.locator('link[rel="canonical"]')).toHaveCount(1);
        await expect(page.locator('script[type="application/ld+json"]')).not.toHaveCount(0);

        const sitemap = await request.get("/sitemap.xml");

        expect(sitemap.status()).toBe(200);
        expect(await sitemap.text()).toContain("<priority>1.0</priority>");
    });
});

test.describe("robots.txt", () => {
    test("is served", async ({ request }) => {
        const robots = await request.get("/robots.txt");

        expect(robots.status()).toBe(200);
        expect(await robots.text()).toContain("Sitemap");
    });
});
