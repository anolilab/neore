/**
 * Creates the dummy login for local development: the shared e2e account
 * (`TEST_USER`), so a manual sign-in and the e2e suite use the same user.
 *
 * It goes through the backend like any other sign-up: a fresh invitation from
 * `POST /e2e/invitations`, then better-auth's sign-up. Nothing is written to
 * the local database directly. Idempotent: an account that already signs in is
 * left alone.
 *
 * The invitation call sends the e2e seed token, so the script refuses any
 * backend whose host is not exactly a loopback name. The password is not printed;
 * it is the fixture in `apps/web/e2e/fixtures.ts`.
 *
 * Needs the backend running (`pnpm dev:backend`) and `E2E_SEED_TOKEN` in
 * `backend/.dev.vars` (written by `pnpm dev:setup`).
 *
 *     pnpm dev:seed-user
 */
import { LUNORA_URL, TEST_USER } from "../apps/web/e2e/fixtures";
import { ensureInvitedUser, isLoopbackUrl } from "../apps/web/e2e/seed";

if (!isLoopbackUrl(LUNORA_URL)) {
    throw new Error(`Refusing to send the e2e seed token to ${LUNORA_URL}: only a loopback backend is seeded.`);
}

await ensureInvitedUser(TEST_USER);

console.log(`Dummy login ready for ${TEST_USER.email}. Its credentials are in the e2e fixtures, apps/web/e2e/fixtures.ts.`);
