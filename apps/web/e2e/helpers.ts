/**
 * E2E helpers.
 *
 * Two kinds live here, and the split matters:
 *
 *  - HTTP helpers (`signInTestUser`; seeding lives in `seed.ts`, because
 *    registration is invite-only) talk to Better Auth directly. Fast, and the
 *    only sane way to seed. They prove the backend works and nothing else.
 *  - `loginViaUI` drives the real form. Slower, and the one that catches the
 *    failures this app actually had — redirects, hydration timing, token
 *    adoption. Keep it to tests OF the login: sign-in is rate-limited per IP,
 *    so a test that only needs a session loads `TEST_USER_STATE` or takes a
 *    fresh `userPage` (`chat-helpers.ts`) instead.
 */

import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";

import type { TEST_ADMIN, TEST_USER } from "./fixtures";
import { APP_BASE_URL, AUTH_API_BASE, AUTH_PATHS } from "./fixtures";

type TestUser = typeof TEST_ADMIN | typeof TEST_USER;

/**
 * better-auth answers 403 `MISSING_OR_NULL_ORIGIN` when a credential request
 * arrives without one, and Node's fetch sends no `Origin` — only a browser does.
 * Every helper here therefore states the origin it is acting as, which is also
 * what makes these requests pass the trusted-origins check the app relies on.
 */
const authHeaders = { "Content-Type": "application/json", Origin: APP_BASE_URL };

interface AuthResponse {
    session?: { id: string; token: string };
    token?: string;
    user?: { email: string; id: string; name: string };
}

/**
 * Better Auth's captcha plugin loads only when the backend has
 * `TURNSTILE_SECRET_KEY` set. When it does, every credential endpoint rejects a
 * request with no Turnstile token — and the browser form has no widget to
 * produce one unless `VITE_TURNSTILE_SITE_KEY` is also set.
 *
 * The two are independent env vars with nothing tying them together, so a
 * machine with one and not the other cannot sign up or sign in at all. Detect
 * it and say so, rather than letting twelve tests fail on a generic timeout.
 */
export const detectCaptchaBlock = async (): Promise<string | null> => {
    try {
        const response = await fetch(`${AUTH_API_BASE}/sign-in/email`, {
            body: JSON.stringify({ email: "captcha-probe@neore.test", password: "not-a-real-password" }),
            headers: authHeaders,
            method: "POST",
        });

        const text = await response.text();

        if (text.includes("MISSING_RESPONSE") || text.includes("Missing CAPTCHA")) {
            return (
                "Backend enforces Turnstile (TURNSTILE_SECRET_KEY is set) but the sign-in form " +
                "renders no widget, so no credential flow can complete. Set VITE_TURNSTILE_SITE_KEY " +
                "to Cloudflare's always-pass test key 1x00000000000000000000AA (secret " +
                "1x0000000000000000000000000000000AA), or unset TURNSTILE_SECRET_KEY."
            );
        }

        return null;
    } catch {
        // Backend unreachable is a different failure; let the tests report it.
        return null;
    }
};

/** Sign in over HTTP and hand back the `Set-Cookie` values. */
export const signInTestUser = async (user: TestUser): Promise<{ cookies: string[]; response: AuthResponse }> => {
    const response = await fetch(`${AUTH_API_BASE}/sign-in/email`, {
        body: JSON.stringify({ email: user.email, password: user.password }),
        headers: authHeaders,
        method: "POST",
    });

    if (!response.ok) {
        throw new Error(`Sign-in failed (${String(response.status)}): ${await response.text()}`);
    }

    return { cookies: response.headers.getSetCookie(), response: (await response.json()) as AuthResponse };
};

/**
 * Wait for the Turnstile widget to produce a token, when captcha is configured.
 *
 * Needed before SUBMIT, not before filling: the form calls `getResponse()` in
 * its submit handler and throws `Missing captcha response` if the widget has not
 * solved yet, so the request is never issued and the failure looks like a button
 * that does nothing. Cloudflare's test key solves immediately, but not
 * synchronously.
 *
 * This used to have to run before filling too, because input entered before
 * hydration was discarded by the first re-render — which the widget's late mount
 * happened to trigger. `FormControl` now adopts whatever the control already
 * holds when it mounts, so filling is safe at any point and the tests type in
 * the order a person would.
 *
 * A no-op when captcha is unconfigured, which is how CI runs.
 */
export const awaitCaptchaToken = async (page: Page): Promise<void> => {
    const token = page.locator('input[name="cf-turnstile-response"]');

    try {
        // The widget mounts after hydration, so a bare count() races it and
        // returns 0 on a page that is about to have one — which is how this
        // silently became a no-op and every credential test then failed with
        // "no request was ever made".
        await token.waitFor({ state: "attached", timeout: 8000 });
    } catch {
        // Genuinely no captcha here (CI configures none). Nothing to wait for.
        return;
    }

    await expect(token).not.toHaveValue("", { timeout: 30_000 });
};

/**
 * Wait until the auth form is INTERACTIVE, not merely painted.
 *
 * The auth pages are server-rendered, so the submit button exists and is
 * `enabled` before React has attached its handler. `toBeEnabled()` therefore
 * passes inside that window, the click does nothing at all — no request, the
 * browser falls back to a native GET — and the failure reads as a form that
 * refuses to submit. That is exactly what two tests did under parallel load,
 * timing out on `waitForResponse` with no request ever made.
 *
 * The forms set `noValidate={isHydrated}`, so `form[novalidate]` is a signal the
 * CLIENT owns: it cannot appear in the SSR markup. Waiting for it is the
 * difference between "the button is drawn" and "the button works".
 */
export const awaitFormHydrated = async (page: Page): Promise<void> => {
    await page.waitForSelector("form[novalidate]", { state: "attached", timeout: 20_000 });
};

/**
 * Sign in through the real form and wait until the app has actually left the
 * auth section.
 *
 * The wait is an assertion, not a sleep. The previous implementation polled for
 * ten seconds and then continued regardless, so a login that never happened
 * produced a passing "logged in" state and the failure surfaced somewhere else
 * entirely.
 */
export const loginViaUI = async (page: Page, user: TestUser, options: { redirectTo?: string } = {}): Promise<void> => {
    await page.goto(AUTH_PATHS.signIn);

    // `toBeEnabled()` is a RENDERING check: the SSR markup paints an enabled
    // button before React attaches the submit handler, so it passes inside the
    // hydration window and the click that follows does nothing at all. Wait for
    // a signal the client owns instead — see `awaitFormHydrated`.
    await awaitFormHydrated(page);

    const submit = page.getByRole("button", { exact: true, name: "Sign in" });

    await page.getByPlaceholder("Enter your email").fill(user.email);
    await page.getByPlaceholder("Enter your password").fill(user.password);
    await awaitCaptchaToken(page);
    await submit.click();

    await page.waitForURL((url) => !url.pathname.startsWith("/auth/"), { timeout: 20_000 });

    if (options.redirectTo) {
        await page.goto(options.redirectTo);
    }
};

/** True when the app is not showing an auth page. */
export const isAuthenticated = (page: Page): boolean => !new URL(page.url()).pathname.startsWith("/auth/");

/** Drop the session and land back on sign-in. */
export const logout = async (page: Page): Promise<void> => {
    await page.request.post(`${AUTH_API_BASE}/sign-out`).catch(() => null);
    await page.context().clearCookies();
    await page.goto(AUTH_PATHS.signIn);
};
