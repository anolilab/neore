import { expect, test } from "@playwright/test";

import { AUTH_PATHS, TEST_USER } from "./fixtures";

const TRAILING_QUERY_RE = /\?$/;
const NAME_FIELD_RE = /name/i;

test.describe("Sign-in page", () => {
    test.beforeEach(async ({ page }) => {
        await page.goto(AUTH_PATHS.signIn);
    });

    test("renders the card, its fields and its actions", async ({ page }) => {
        await expect(page.getByText("Welcome back")).toBeVisible();
        await expect(page.getByText("Enter your email below to login to your account")).toBeVisible();
        await expect(page.getByPlaceholder("Enter your email")).toBeVisible();
        await expect(page.getByPlaceholder("Enter your password")).toBeVisible();
        await expect(page.getByRole("button", { exact: true, name: "Sign in" })).toBeVisible();
        // Cross-navigation out of the card is anchors, not buttons — the submit
        // control is the only button on it.
        await expect(page.getByRole("link", { exact: true, name: "Sign up" })).toBeVisible();
        await expect(page.getByRole("link", { name: "Forgot password?" })).toBeVisible();
    });

    test("accepts typing into both credential fields", async ({ page }) => {
        const email = page.getByPlaceholder("Enter your email");
        const password = page.getByPlaceholder("Enter your password");

        await email.fill(TEST_USER.email);
        await password.fill(TEST_USER.password);

        await expect(email).toHaveValue(TEST_USER.email);
        await expect(password).toHaveValue(TEST_USER.password);
    });

    test("does not render the password in clear text", async ({ page }) => {
        const password = page.getByPlaceholder("Enter your password");

        await password.fill(TEST_USER.password);

        await expect(password).toHaveAttribute("type", "password");
    });

    test("becomes interactive, not merely visible", async ({ page }) => {
        /**
         * The auth pages are server-rendered, so the inputs paint — and read as
         * visible — before React has attached the submit handler. A click inside
         * that window does nothing at all: no request, and the browser falls back
         * to a native GET that shows up as a navigation to `/auth/sign-in?`.
         *
         * It looks exactly like a form that refuses to submit, and it is the
         * single most expensive false alarm this app produces.
         */
        await expect(page.getByRole("button", { exact: true, name: "Sign in" })).toBeEnabled();
        await expect(page).not.toHaveURL(TRAILING_QUERY_RE);
    });
});

test.describe("Sign-up page", () => {
    test.beforeEach(async ({ page }) => {
        await page.goto(AUTH_PATHS.signUp);
    });

    test("renders the registration form", async ({ page }) => {
        await expect(page.getByText("Enter your information to create an account")).toBeVisible();
        await expect(page.getByPlaceholder("Enter your email")).toBeVisible();
        await expect(page.getByPlaceholder("Enter your password")).toBeVisible();
        await expect(page.getByText("Already have an account?")).toBeVisible();
    });

    test("asks for a name as well as credentials", async ({ page }) => {
        await expect(page.getByPlaceholder(NAME_FIELD_RE).first()).toBeVisible();
    });
});

test.describe("Forgot-password page", () => {
    test("renders its form", async ({ page }) => {
        await page.goto(AUTH_PATHS.forgotPassword);

        await expect(page.getByText("Enter your email to reset your password")).toBeVisible();
        await expect(page.getByPlaceholder("Enter your email")).toBeVisible();
    });
});
