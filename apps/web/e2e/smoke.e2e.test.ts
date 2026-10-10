import { expect, test } from "@playwright/test";

import { AUTH_PATHS, PUBLIC_PATHS } from "./fixtures";

test.describe("Smoke", () => {
    test("serves the public models page", async ({ page }) => {
        const response = await page.goto(PUBLIC_PATHS.models);

        expect(response?.status()).toBe(200);
        await expect(page.getByRole("heading").first()).toBeVisible();
    });

    test("serves the sign-in page with a usable form", async ({ page }) => {
        await page.goto(AUTH_PATHS.signIn);

        await expect(page.getByPlaceholder("Enter your email")).toBeVisible();
        await expect(page.getByPlaceholder("Enter your password")).toBeVisible();
        await expect(page.getByRole("button", { exact: true, name: "Sign in" })).toBeEnabled();
    });

    test("renders in English when the client asks for it", async ({ page }) => {
        await page.goto(AUTH_PATHS.signIn);

        // The app ships English and German and picks from Accept-Language. The
        // config pins en-US; this asserts the pin is actually taking effect,
        // because if it stops every copy assertion in the suite fails at once
        // and none of them say why.
        await expect(page.locator("html")).toHaveAttribute("lang", "en");
    });
});
