/**
 * The gateway's cron schedule — what `scheduled()` in `index.ts` switches on.
 * `alchemy.run.ts` deploys exactly these (Alchemy does not read wrangler.jsonc),
 * and `backend/deploy-env-bindings.test.ts` pins `wrangler.jsonc`'s `triggers.crons` (local dev) to it.
 */
export const GATEWAY_CRONS = ["5 0 * * *", "0 2 * * *", "0 4 * * 0", "*/5 * * * *"];
