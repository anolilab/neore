/**
 * `POST /admin/backfill-email-canonical`: fills one batch of `user.emailCanonical` (`email-canonical-backfill.ts`). The
 * deploy calls it after the smoke test until it answers `done` (`scripts/run-data-migrations.ts`), with bearer
 * `LUNORA_ADMIN_TOKEN`:
 *
 *     curl -X POST "$PUBLIC_ORIGIN/admin/backfill-email-canonical" \
 *          -H "Authorization: Bearer $LUNORA_ADMIN_TOKEN"
 *
 * Answers counts only, never an address or a user id: the deploy's log is public. `conflict` answers 409, with no row
 * written by that call.
 */
import type { HttpActionCtx } from "lunorash/server";

import { internal } from "../_generated/internal";
import type { AdminBearerDependencies } from "./admin-bearer";
import { NO_STORE, refuseUnlessAdminBearer } from "./admin-bearer";
import type { EmailCanonicalBackfillResult } from "./email-canonical-backfill";

/** The limit this route draws on; see `RATE_LIMIT_CONFIGS`. */
export const EMAIL_CANONICAL_RATE_LIMIT_KEY = "admin/backfillEmailCanonical";

export interface EmailCanonicalBackfillDependencies extends AdminBearerDependencies {
    backfill: () => Promise<EmailCanonicalBackfillResult>;
}

export const createEmailCanonicalBackfillHandler =
    (dependencies: EmailCanonicalBackfillDependencies) =>
    async (request: Request): Promise<Response> => {
        const refusal = await refuseUnlessAdminBearer(request, dependencies);

        if (refusal !== undefined) {
            return refusal;
        }

        const { conflicts, filled, remaining, status } = await dependencies.backfill();

        return Response.json({ conflicts, filled, remaining, status }, { headers: NO_STORE, status: status === "conflict" ? 409 : 200 });
    };

export const emailCanonicalBackfillHttpAction = async (context: HttpActionCtx, request: Request): Promise<Response> =>
    await createEmailCanonicalBackfillHandler({
        adminToken: () => process.env.LUNORA_ADMIN_TOKEN ?? "",
        backfill: async () => await context.runMutation(internal.auth.email_canonical_backfill.backfillEmailCanonical, {}),
        rateLimit: async (identifier) =>
            await context.runMutation(internal.lib.rate_limiter_mutations.applyRateLimit, { identifier, key: EMAIL_CANONICAL_RATE_LIMIT_KEY }),
    })(request);
