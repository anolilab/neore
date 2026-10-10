import { expect, test } from "@playwright/test";

import { AUTH_PATHS, PROTECTED_PATHS, PUBLIC_PATHS } from "./fixtures";

const SIGN_IN_URL_RE = /\/auth\/sign-in/;
const ADMIN_URL_RE = /\/admin$/;

test.describe("Auth route navigation", () => {
    test("moves between sign-in and sign-up in both directions", async ({ page }) => {
        await page.goto(AUTH_PATHS.signIn);

        await page.getByRole("link", { exact: true, name: "Sign up" }).click();
        await expect(page.getByText("Enter your information to create an account")).toBeVisible();

        await page.getByRole("link", { exact: true, name: "Sign in" }).click();
        await expect(page.getByText("Welcome back")).toBeVisible();
    });

    test("reaches forgot-password from sign-in", async ({ page }) => {
        await page.goto(AUTH_PATHS.signIn);

        await page.getByRole("link", { name: "Forgot password?" }).click();

        await expect(page.getByText("Enter your email to reset your password")).toBeVisible();
    });

    test("serves each auth page on direct navigation", async ({ page }) => {
        await page.goto(AUTH_PATHS.signUp);
        await expect(page.getByText("Enter your information to create an account")).toBeVisible();

        await page.goto(AUTH_PATHS.forgotPassword);
        await expect(page.getByText("Enter your email to reset your password")).toBeVisible();

        await page.goto(AUTH_PATHS.signIn);
        await expect(page.getByText("Welcome back")).toBeVisible();
    });
});

test.describe("Protected routes while signed out", () => {
    /**
     * The load-bearing half of routing. A gate that silently stops firing hands
     * anonymous callers a dashboard, and nothing else in the suite would notice.
     */
    test("sends /dashboard to sign-in", async ({ page }) => {
        await page.goto(PROTECTED_PATHS.dashboard);

        await expect(page).toHaveURL(new RegExp(`${AUTH_PATHS.signIn}$`));
    });

    test("sends /dashboard/settings to sign-in", async ({ page }) => {
        await page.goto(PROTECTED_PATHS.settings);

        await expect(page).toHaveURL(SIGN_IN_URL_RE);
    });

    test("does not leak the admin area", async ({ page }) => {
        await page.goto("/admin");

        await expect(page).not.toHaveURL(ADMIN_URL_RE);
    });
});

test.describe("Unknown routes", () => {
    test("does not 500 on a route that does not exist", async ({ page }) => {
        const response = await page.goto("/this-route-does-not-exist");

        // 404 or a redirect are both fine; a 5xx is a server bug.
        expect(response?.status()).toBeLessThan(500);
    });
});

test.describe("Public navigation", () => {
    test("keeps the navbar links working on the models page", async ({ page }) => {
        await page.goto(PUBLIC_PATHS.models);

        await expect(page.getByRole("navigation").first()).toBeVisible();
        await expect(page.getByText("Text & chat")).toBeVisible();
    });
});
