/**
 * `POST /admin/seed-invitations` — the operator's way to open a fresh deployment.
 *
 * The app is invite-only, and the first invitation cannot come from
 * `createInvitation` because that needs an admin, who needs an account, which
 * needs an invitation. `seedAdminInvitationLinks` breaks the loop, and this
 * route is its only entry point — `lunora run` cannot dispatch an internal
 * function (not even with `--as`, which only changes WHO a public call runs
 * as), so an internal twin would be unreachable:
 *
 *     curl -X POST "$PUBLIC_ORIGIN/admin/seed-invitations" \
 *          -H "Authorization: Bearer $LUNORA_ADMIN_TOKEN"
 *
 * Gated by `LUNORA_ADMIN_TOKEN` — the same deploy secret the jobs queue and
 * `lunora` admin tooling already authenticate with, required by
 * `alchemy.run.ts`. Unset, the route answers 503 rather than falling open.
 * `?reissue=1` re-mints still-pending links (a lost link cannot be recovered;
 * only its SHA-256 is stored). Without it the call is idempotent — see
 * `seedAdminInvitationLinks`.
 */
import type { HttpActionCtx } from "lunorash/server";

import { internal } from "../_generated/internal";
import { secretsMatch } from "../lib/crypto";
import type { SeededInvitation } from "./invitations";
import { seedAdminInvitationLinks } from "./invitations";

/** The limit this route draws on; see `RATE_LIMIT_CONFIGS`. */
export const SEED_RATE_LIMIT_KEY = "admin/seedInvitations";

const BEARER_PREFIX = /^Bearer\s+/i;

export interface SeedInvitationsDependencies {
    /** The configured admin token; empty means the route is disabled. */
    adminToken: () => string;
    /** Charges one attempt to `identifier`; `ok: false` means over the limit. */
    rateLimit: (identifier: string) => Promise<{ ok: boolean; retryAfter?: number }>;
    seed: (options: { reissue: boolean }) => Promise<SeededInvitation[]>;
}

const noStore = { "cache-control": "no-store" };

/**
 * The route, with its dependencies injected so the auth check and idempotency
 * can be tested without a worker.
 *
 * The rate limit is charged BEFORE the token check and per client IP, so it
 * throttles token guessing, not just successful seeds.
 */
export const createSeedInvitationsHandler =
    (dependencies: SeedInvitationsDependencies) =>
    async (request: Request): Promise<Response> => {
        const limit = await dependencies.rateLimit(request.headers.get("cf-connecting-ip") ?? "unknown");

        if (!limit.ok) {
            const retryAfterSeconds = Math.ceil((limit.retryAfter ?? 60_000) / 1000);

            return Response.json({ error: "Too many requests" }, { headers: { ...noStore, "retry-after": String(retryAfterSeconds) }, status: 429 });
        }

        const expected = dependencies.adminToken();

        if (!expected) {
            return Response.json({ error: "LUNORA_ADMIN_TOKEN is not configured" }, { headers: noStore, status: 503 });
        }

        const header = request.headers.get("authorization") ?? "";
        const presented = BEARER_PREFIX.test(header) ? header.replace(BEARER_PREFIX, "").trim() : "";

        if (!presented || !(await secretsMatch(presented, expected))) {
            return Response.json({ error: "Unauthorized" }, { headers: { ...noStore, "www-authenticate": "Bearer" }, status: 401 });
        }

        const reissueParameter = new URL(request.url).searchParams.get("reissue");
        const invitations = await dependencies.seed({ reissue: reissueParameter === "1" || reissueParameter === "true" });

        return Response.json({ invitations }, { headers: noStore, status: 200 });
    };

export const seedInvitationsHttpAction = async (context: HttpActionCtx, request: Request): Promise<Response> =>
    await createSeedInvitationsHandler({
        adminToken: () => process.env.LUNORA_ADMIN_TOKEN ?? "",
        rateLimit: async (identifier) =>
            await context.runMutation(internal.lib.rate_limiter_mutations.applyRateLimit, { identifier, key: SEED_RATE_LIMIT_KEY }),
        seed: seedAdminInvitationLinks,
    })(request);
