/**
 * Creates the dummy login for local development: the shared e2e account
 * (`TEST_USER`), so a manual sign-in and the e2e suite use the same user.
 *
 * It goes through the backend like any other sign-up: a fresh invitation from
 * `POST /e2e/invitations`, then better-auth's sign-up. Nothing is written to
 * the local database directly. Idempotent: an account that already signs in is
 * left alone.
 *
 * Needs the backend running (`pnpm dev:backend`) and `E2E_SEED_TOKEN` in
 * `backend/.dev.vars` (written by `pnpm dev:setup`).
 *
 *     pnpm dev:seed-user
 */
import { TEST_USER } from "../apps/web/e2e/fixtures";
import { ensureInvitedUser } from "../apps/web/e2e/seed";

await ensureInvitedUser(TEST_USER);

console.log(`Dummy login ready: ${TEST_USER.email} / ${TEST_USER.password}`);
