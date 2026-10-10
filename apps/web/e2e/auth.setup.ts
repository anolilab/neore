/**
 * Signs TEST_USER in once per run and saves the browser state the `Session`
 * specs load, instead of each of them signing in through the form (see
 * `TEST_USER_STATE`). The form itself is still exercised, once, by
 * `authenticated.e2e.test.ts` → "Sign in".
 */
import { test as setup } from "@playwright/test";

import { contextPoster } from "./chat-helpers";
import { TEST_USER, TEST_USER_STATE } from "./fixtures";
import { detectCaptchaBlock } from "./helpers";
import { ensureInvitedUser } from "./seed";

setup("sign in the shared test user", async ({ page }) => {
    // With captcha misconfigured no sign-in can succeed; the specs skip with the
    // reason themselves, so save the signed-out state rather than fail here.
    if (!(await detectCaptchaBlock())) {
        await ensureInvitedUser(TEST_USER, contextPoster(page));
    }

    await page.context().storageState({ path: TEST_USER_STATE });
});
