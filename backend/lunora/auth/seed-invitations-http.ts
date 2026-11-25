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
import type { AdminBearerDependencies } from "./admin-bearer";
import { NO_STORE, refuseUnlessAdminBearer } from "./admin-bearer";
import type { SeededInvitation } from "./invitations";
import { seedAdminInvitationLinks } from "./invitations";

/** The limit this route draws on; see `RATE_LIMIT_CONFIGS`. */
export const SEED_RATE_LIMIT_KEY = "admin/seedInvitations";

export interface SeedInvitationsDependencies extends AdminBearerDependencies {
    seed: (options: { reissue: boolean }) => Promise<SeededInvitation[]>;
}

/**
 * The route, with its dependencies injected so the auth check and idempotency
 * can be tested without a worker. The gate is `refuseUnlessAdminBearer`.
 */
export const createSeedInvitationsHandler =
    (dependencies: SeedInvitationsDependencies) =>
    async (request: Request): Promise<Response> => {
        const refusal = await refuseUnlessAdminBearer(request, dependencies);

        if (refusal !== undefined) {
            return refusal;
        }

        const reissueParameter = new URL(request.url).searchParams.get("reissue");
        const invitations = await dependencies.seed({ reissue: reissueParameter === "1" || reissueParameter === "true" });

        return Response.json({ invitations }, { headers: NO_STORE, status: 200 });
    };

export const seedInvitationsHttpAction = async (context: HttpActionCtx, request: Request): Promise<Response> =>
    await createSeedInvitationsHandler({
        adminToken: () => process.env.LUNORA_ADMIN_TOKEN ?? "",
        rateLimit: async (identifier) =>
            await context.runMutation(internal.lib.rate_limiter_mutations.applyRateLimit, { identifier, key: SEED_RATE_LIMIT_KEY }),
        seed: seedAdminInvitationLinks,
    })(request);
