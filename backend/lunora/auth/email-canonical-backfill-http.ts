/**
 * `POST /admin/backfill-email-canonical`: one call of the `user.emailCanonical` backfill (`email-canonical-backfill.ts`), with
 * bearer `LUNORA_ADMIN_TOKEN`. The deploy drives it after the smoke test (`scripts/run-data-migrations.ts`): check calls
 * until `checked`, then fill calls until `filled`, then a check again, which answers `done` when nothing is left. The body
 * names the phase and carries the cursor:
 *
 *     { "phase": "check", "salt": "<random>", "cursor": "<from the last check>" }
 *     { "phase": "fill", "checkedAt": <from the check's first answer>, "cursor": "<from the last fill>" }
 *
 * A call without a body is a check from the start with a salt of its own: it never writes.
 *
 * A check answers salted digests of the canonical addresses it read, so the caller can find a pair two calls split; never an
 * address or a user id. The deploy's log prints counts only. `conflict` answers 409, with no row written by that call.
 */
import type { HttpActionCtx } from "lunorash/server";

import { internal } from "../_generated/internal";
import type { AdminBearerDependencies } from "./admin-bearer";
import { NO_STORE, refuseUnlessAdminBearer } from "./admin-bearer";
import type { EmailCanonicalCheckResult, EmailCanonicalFillResult } from "./email-canonical-backfill";

/** The limit this route draws on; see `RATE_LIMIT_CONFIGS`. */
export const EMAIL_CANONICAL_RATE_LIMIT_KEY = "admin/backfillEmailCanonical";

/** The longest cursor or salt the route accepts. */
const MAX_TOKEN_LENGTH = 512;

export type EmailCanonicalBackfillRequest = { checkedAt: number; cursor?: string; phase: "fill" } | { cursor?: string; phase: "check"; salt: string };

export interface EmailCanonicalBackfillDependencies extends AdminBearerDependencies {
    check: (input: { cursor?: string; salt: string }) => Promise<EmailCanonicalCheckResult>;
    fillBatch: (input: { checkedAt: number; cursor?: string }) => Promise<EmailCanonicalFillResult>;
}

const shortString = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= MAX_TOKEN_LENGTH;

const randomSalt = (): string => [...crypto.getRandomValues(new Uint8Array(16))].map((byte) => byte.toString(16).padStart(2, "0")).join("");

/** The call `body` asks for, or `undefined` when it is not one. An empty body is a check from the start. */
export const parseBackfillRequest = (text: string): EmailCanonicalBackfillRequest | undefined => {
    if (text.trim() === "") {
        return { phase: "check", salt: randomSalt() };
    }

    let body: unknown;

    try {
        body = JSON.parse(text);
    } catch {
        return undefined;
    }

    if (typeof body !== "object" || body === null) {
        return undefined;
    }

    const { checkedAt, cursor, phase, salt } = body as Record<string, unknown>;

    if (cursor !== undefined && !shortString(cursor)) {
        return undefined;
    }

    const at = cursor === undefined ? {} : { cursor };

    if (phase === "check" && shortString(salt)) {
        return { phase, salt, ...at };
    }

    if (phase === "fill" && typeof checkedAt === "number" && Number.isSafeInteger(checkedAt) && checkedAt > 0) {
        return { checkedAt, phase, ...at };
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
            return Response.json({ error: "Expected a check (phase, salt) or a fill (phase, checkedAt) call" }, { headers: NO_STORE, status: 400 });
        }

        const result =
            call.phase === "check"
                ? await dependencies.check({ cursor: call.cursor, salt: call.salt })
                : await dependencies.fillBatch({ checkedAt: call.checkedAt, cursor: call.cursor });

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
