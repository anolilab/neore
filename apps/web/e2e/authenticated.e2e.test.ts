import { expect, test } from "@playwright/test";

import { AUTH_PATHS, PROTECTED_PATHS, TEST_USER, TEST_USER_STATE } from "./fixtures";
import { awaitCaptchaToken, awaitFormHydrated, detectCaptchaBlock, loginViaUI } from "./helpers";
import { inviteLink } from "./seed";

const NAME_FIELD_RE = /name/i;
const SIGN_UP_URL_RE = /\/auth\/sign-up/;
const SIGN_IN_URL_RE = /\/auth\/sign-in/;
const AUTH_URL_RE = /\/auth\//;

/**
 * Everything here needs a credential flow to complete. When the backend has
 * `TURNSTILE_SECRET_KEY` set but the app has no `VITE_TURNSTILE_SITE_KEY`, the
 * form renders no captcha widget and every one of these endpoints answers
 * `MISSING_RESPONSE` — so skip with the reason instead of a dozen timeouts.
 */
const captcha: { block: string | null } = { block: null };

// TEST_USER itself is seeded (invite-only registration) by the `setup` project, `auth.setup.ts`.
test.beforeAll(async () => {
    captcha.block = await detectCaptchaBlock();
});

test.beforeEach(() => {
    // Conditional, not a disabled test: it only skips when captcha is misconfigured.
    test.skip(Boolean(captcha.block), captcha.block ?? "");
});

test.describe("Registration", () => {
    /**
     * This is the flow that had no coverage at all. The old suite asserted that
     * the sign-up form *rendered* and stopped there, so a registration that
     * silently posted nothing would have passed every check.
     */
    test("registers a new account through the form", async ({ page }) => {
        const stamp = Date.now();
        const email = `e2e-signup-${String(stamp)}@neore.test`;

        // Invite-only: the form reads the token off `?invite=` at submit time.
        await page.goto(await inviteLink(email));

        // "Sign Up" — the submit button is title-case, while the link back to
        // this page from the sign-in card is lowercase "Sign up". Same words,
        // different casing, different element.
        const submit = page.getByRole("button", { exact: true, name: "Sign Up" });

        await expect(submit).toBeEnabled();
        await awaitFormHydrated(page);

        await page
            .getByPlaceholder(NAME_FIELD_RE)
            .first()
            .fill(`E2E Signup ${String(stamp)}`);
        await page.getByPlaceholder("Enter your email").fill(email);
        await page.getByPlaceholder("Enter your password").fill("SignupTest!2345");

        // Assert on the request the click makes, not on a timer. A fixed wait
        // reports "registration failed" whenever the page is a second slow, and
        // reports success when the click did nothing at all.
        await awaitCaptchaToken(page);

        const [response] = await Promise.all([page.waitForResponse((r) => r.url().includes("/sign-up/email"), { timeout: 30_000 }), submit.click()]);

        expect(response.status(), await response.text()).toBeLessThan(400);
    });

    test("refuses a duplicate email", async ({ page }) => {
        // With a VALID invitation, so the refusal is the duplicate and not the
        // invite gate — without one this passes for the wrong reason.
        await page.goto(await inviteLink(TEST_USER.email));

        // "Sign Up" — the submit button is title-case, while the link back to
        // this page from the sign-in card is lowercase "Sign up". Same words,
        // different casing, different element.
        const submit = page.getByRole("button", { exact: true, name: "Sign Up" });

        await expect(submit).toBeEnabled();
        await awaitFormHydrated(page);

        await page.getByPlaceholder(NAME_FIELD_RE).first().fill(TEST_USER.name);
        await page.getByPlaceholder("Enter your email").fill(TEST_USER.email);
        await page.getByPlaceholder("Enter your password").fill(TEST_USER.password);

        await awaitCaptchaToken(page);

        const [response] = await Promise.all([page.waitForResponse((r) => r.url().includes("/sign-up/email"), { timeout: 30_000 }), submit.click()]);

        expect(response.status()).toBeGreaterThanOrEqual(400);
        await expect(page).toHaveURL(SIGN_UP_URL_RE);
    });
});

test.describe("Sign in", () => {
    /**
     * These three are the suite's only form sign-ins, and each must get a real
     * answer: sign-in is limited to 3 per IP, and the count resets only after a
     * 10s QUIET gap (`backend/lunora/auth.ts`). Earlier calls on the path (the
     * setup project, the captcha probe, account deletion's check) leave an
     * unknown count, so wait out one gap — then these three fit exactly, and a
     * rejection below is the credentials' and not a 429.
     */
    test.beforeAll(async () => {
        await new Promise((resolve) => {
            setTimeout(resolve, 11_000);
        });
    });

    test("signs in with valid credentials and leaves the auth section", async ({ page }) => {
        await loginViaUI(page, TEST_USER);

        expect(new URL(page.url()).pathname.startsWith("/auth/")).toBe(false);
    });

    test("rejects an unknown account and stays put", async ({ page }) => {
        await page.goto(AUTH_PATHS.signIn);

        const submit = page.getByRole("button", { exact: true, name: "Sign in" });

        await expect(submit).toBeEnabled();
        await awaitFormHydrated(page);
        await page.getByPlaceholder("Enter your email").fill("nobody@neore.test");
        await page.getByPlaceholder("Enter your password").fill("WrongPassword123!");

        await awaitCaptchaToken(page);

        const [response] = await Promise.all([page.waitForResponse((r) => r.url().includes("/sign-in/email"), { timeout: 30_000 }), submit.click()]);

        expect(response.status()).toBeGreaterThanOrEqual(400);
        await expect(page).toHaveURL(SIGN_IN_URL_RE);
    });

    test("rejects a wrong password for a real account", async ({ page }) => {
        await page.goto(AUTH_PATHS.signIn);

        const submit = page.getByRole("button", { exact: true, name: "Sign in" });

        await expect(submit).toBeEnabled();
        await awaitFormHydrated(page);
        await page.getByPlaceholder("Enter your email").fill(TEST_USER.email);
        await page.getByPlaceholder("Enter your password").fill("DefinitelyNotThePassword1!");

        await awaitCaptchaToken(page);

        const [response] = await Promise.all([page.waitForResponse((r) => r.url().includes("/sign-in/email"), { timeout: 30_000 }), submit.click()]);

        expect(response.status()).toBeGreaterThanOrEqual(400);
        await expect(page).toHaveURL(SIGN_IN_URL_RE);
    });
});

test.describe("Session", () => {
    // Signed in once by the `setup` project, not through the form per test (see `TEST_USER_STATE`).
    test.use({ storageState: TEST_USER_STATE });

    test("reaches the chat page", async ({ page }) => {
        await page.goto(PROTECTED_PATHS.chat);

        await expect(page).not.toHaveURL(AUTH_URL_RE);
    });

    test("reaches the dashboard", async ({ page }) => {
        await page.goto(PROTECTED_PATHS.dashboard);

        await expect(page).not.toHaveURL(AUTH_URL_RE);
    });

    test("survives navigation between protected routes", async ({ page }) => {
        await page.goto(PROTECTED_PATHS.chat);
        await expect(page).not.toHaveURL(AUTH_URL_RE);

        await page.goto(PROTECTED_PATHS.dashboard);
        await expect(page).not.toHaveURL(AUTH_URL_RE);
    });

    test("survives a full reload", async ({ page }) => {
        /**
         * `&lt;Unauthenticated>` means "no RPC token yet", not "no session". The
         * token is fetched after the session cookie lands, so a signed-in user
         * reads as logged-out for a window — and the app once sat there forever
         * because nothing fetched a token for an existing session. A reload is
         * the cheapest way to re-enter that window on purpose.
         */
        await page.goto(PROTECTED_PATHS.dashboard);
        await page.reload();

        await expect(page).not.toHaveURL(AUTH_URL_RE);
    });

    test("drops access once the cookies are cleared", async ({ page }) => {
        await page.goto(PROTECTED_PATHS.dashboard);
        await expect(page).not.toHaveURL(AUTH_URL_RE);

        await page.context().clearCookies();
        await page.goto(PROTECTED_PATHS.dashboard);

        await expect(page).toHaveURL(SIGN_IN_URL_RE);
    });
});
