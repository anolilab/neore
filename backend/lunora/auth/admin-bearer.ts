/**
 * The gate in front of the operator routes under `/admin/*` that `LUNORA_ADMIN_TOKEN` opens (`seed-invitations-http.ts`,
 * `email-canonical-backfill-http.ts`). `lunora run` cannot dispatch an internal function, so these routes are how the
 * operator and the deploy reach one.
 *
 * The rate limit is charged BEFORE the token check and per client IP, so it throttles token guessing, not just successful
 * calls. Unset, the token disables the route (503) rather than opening it. The bearer is compared in constant time.
 */
import { secretsMatch } from "../lib/crypto";

export interface AdminBearerDependencies {
    /** The configured admin token; empty means the route is disabled. */
    adminToken: () => string;
    /** Charges one attempt to `identifier`; `ok: false` means over the limit. */
    rateLimit: (identifier: string) => Promise<{ ok: boolean; retryAfter?: number }>;
}

const BEARER_PREFIX = /^Bearer\s+/i;

export const NO_STORE = { "cache-control": "no-store" };

/** The refusal for `request`, or `undefined` when it carries the admin token and is within the limit. */
export const refuseUnlessAdminBearer = async (request: Request, dependencies: AdminBearerDependencies): Promise<Response | undefined> => {
    const limit = await dependencies.rateLimit(request.headers.get("cf-connecting-ip") ?? "unknown");

    if (!limit.ok) {
        const retryAfterSeconds = Math.ceil((limit.retryAfter ?? 60_000) / 1000);

        return Response.json({ error: "Too many requests" }, { headers: { ...NO_STORE, "retry-after": String(retryAfterSeconds) }, status: 429 });
    }

    const expected = dependencies.adminToken();

    if (!expected) {
        return Response.json({ error: "LUNORA_ADMIN_TOKEN is not configured" }, { headers: NO_STORE, status: 503 });
    }

    const header = request.headers.get("authorization") ?? "";
    const presented = BEARER_PREFIX.test(header) ? header.replace(BEARER_PREFIX, "").trim() : "";

    if (!presented || !(await secretsMatch(presented, expected))) {
        return Response.json({ error: "Unauthorized" }, { headers: { ...NO_STORE, "www-authenticate": "Bearer" }, status: 401 });
    }

    return undefined;
};
