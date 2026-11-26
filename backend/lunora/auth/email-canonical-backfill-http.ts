/**
 * `POST /admin/backfill-email-canonical`: one call of the `user.emailCanonical` backfill (`email-canonical-backfill.ts`), with
 * bearer `LUNORA_ADMIN_TOKEN`. The deploy drives it after the smoke test (`scripts/run-data-migrations.ts`): check calls
 * until `checked`, then fill calls over the unfilled ids the check answered, then a check again, which answers `done` when
 * nothing is left. The body names the phase:
 *
 *     { "phase": "check" }                                   a new check; answers its token
 *     { "phase": "check", "token": "<from the check>" }      the check's next pages, from the cursor the server keeps
 *     { "phase": "fill", "token": "<of a completed check>", "ids": ["<one of that check's unfilledIds>"] }
 *
 * A call without a body is a new check. The server keeps the check's cursor, start time and the ids it read: a fill names
 * the check only, and takes only ids that check recorded, at the time it began. A body with any other key is refused.
 *
 * A check answers the ids of the unfilled rows it read, never an address. The deploy's log prints counts only. `conflict`
 * answers 409, with no row written by that call.
 */
import type { HttpActionCtx } from "lunorash/server";

import { internal } from "../_generated/internal";
import type { AdminBearerDependencies } from "./admin-bearer";
import { NO_STORE, refuseUnlessAdminBearer } from "./admin-bearer";
import type { Id } from "../_generated/dataModel";
import type { EmailCanonicalCheckResult, EmailCanonicalFillResult } from "./email-canonical-backfill";
import { MAX_LENGTH } from "../lib/validators";
import { EMAIL_CANONICAL_BATCH } from "./email-canonical-backfill";

/** The limit this route draws on; see `RATE_LIMIT_CONFIGS`. */
export const EMAIL_CANONICAL_RATE_LIMIT_KEY = "admin/backfillEmailCanonical";

/** The longest token or id the route accepts. */
const MAX_TOKEN_LENGTH = MAX_LENGTH.id;

const CHECK_KEYS = new Set(["phase", "token"]);
const FILL_KEYS = new Set(["ids", "phase", "token"]);

export type EmailCanonicalBackfillRequest = { ids: Id<"user">[]; phase: "fill"; token: string } | { phase: "check"; token?: string };

export interface EmailCanonicalBackfillDependencies extends AdminBearerDependencies {
    check: (input: { token?: string }) => Promise<EmailCanonicalCheckResult>;
    fillBatch: (input: { ids: Id<"user">[]; token: string }) => Promise<EmailCanonicalFillResult>;
}

const shortString = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= MAX_TOKEN_LENGTH;

/** The call `body` asks for, or `undefined` when it is not one. An empty body is a new check. */
export const parseBackfillRequest = (text: string): EmailCanonicalBackfillRequest | undefined => {
    if (text.trim() === "") {
        return { phase: "check" };
    }

    let body: unknown;

    try {
        body = JSON.parse(text);
    } catch {
        return undefined;
    }

    if (typeof body !== "object" || body === null || Array.isArray(body)) {
        return undefined;
    }

    const record = body as Record<string, unknown>;
    const keys = Object.keys(record);
    const { ids, phase, token } = record;

    if (phase === "check" && keys.every((key) => CHECK_KEYS.has(key))) {
        if (token === undefined) {
            return { phase };
        }

        return shortString(token) ? { phase, token } : undefined;
    }

    if (
        phase === "fill" &&
        keys.every((key) => FILL_KEYS.has(key)) &&
        shortString(token) &&
        Array.isArray(ids) &&
        ids.length <= EMAIL_CANONICAL_BATCH &&
        ids.every((id) => shortString(id))
    ) {
        return { ids: ids as Id<"user">[], phase, token };
    }

    return undefined;
};

export const createEmailCanonicalBackfillHandler =
    (dependencies: EmailCanonicalBackfillDependencies) =>
    async (request: Request): Promise<Response> => {
        const refusal = await refuseUnlessAdminBearer(request, dependencies);

        if (refusal !== undefined) {
            return refusal;
        }

        const call = parseBackfillRequest(await request.text());

        if (call === undefined) {
            return Response.json(
                { code: "BAD_REQUEST", error: "Expected a check (phase, token?) or a fill (phase, token, ids) call" },
                { headers: NO_STORE, status: 400 },
            );
        }

        const result =
            call.phase === "check"
                ? await dependencies.check({ ...(call.token !== undefined && { token: call.token }) })
                : await dependencies.fillBatch({ ids: call.ids, token: call.token });

        return Response.json(result, { headers: NO_STORE, status: result.status === "conflict" ? 409 : 200 });
    };

export const emailCanonicalBackfillHttpAction = async (context: HttpActionCtx, request: Request): Promise<Response> =>
    await createEmailCanonicalBackfillHandler({
        adminToken: () => process.env.LUNORA_ADMIN_TOKEN ?? "",
        check: async (input) => await context.runMutation(internal.auth.email_canonical_backfill.checkEmailCanonical, input),
        fillBatch: async (input) => await context.runMutation(internal.auth.email_canonical_backfill.fillEmailCanonical, input),
        rateLimit: async (identifier) =>
            await context.runMutation(internal.lib.rate_limiter_mutations.applyRateLimit, { identifier, key: EMAIL_CANONICAL_RATE_LIMIT_KEY }),
    })(request);
