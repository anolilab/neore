/**
 * `POST /e2e/invitations` — mints a sign-up invitation for the e2e suite.
 *
 * The suite needs a fresh invitation for an arbitrary address, and
 * `createInvitation` needs an admin. It used to write the `signUpInvitation`
 * row straight into the local D1 SQLite file, which workerd holds open and
 * writes to as well — the two contended, and a seed that lost answered
 * "database is locked" (a 500 on the page under test). Going through the
 * backend puts the write where every other write is.
 *
 *     curl -X POST http://localhost:8788/e2e/invitations \
 *          -H "Authorization: Bearer $E2E_SEED_TOKEN" -d '{"email":"a@b.c"}'
 *     → { "token": "<the ?invite= value>" }
 *
 * Minting a working invitation for any address is registration for anyone, so
 * the route must not exist outside a local stack. It answers 404 — exactly what
 * an unmounted path answers — unless ALL of these hold:
 *
 * - `ENVIRONMENT` is `"development"`. A deploy sets `production`/`preview`
 *   (`alchemy.run.ts`), and unset reads as `""`.
 * - `PUBLIC_ORIGIN` is a loopback origin. `lunora build` refuses a loopback
 *   address in `wrangler.jsonc`, and the deploy sets the real origin, so no
 *   deployed Worker carries one.
 * - `E2E_SEED_TOKEN` is set. Only `scripts/dev-setup.js` and CI's e2e job write
 *   it, into the gitignored `backend/.dev.vars`; `alchemy.run.ts` binds no such
 *   secret. A dedicated token rather than `LUNORA_ADMIN_TOKEN`, so a production
 *   admin secret can never be what unlocks a test path.
 *
 * Only then is the bearer compared (constant time).
 */
import { createSignUpInvitation } from "@lunora/auth";
import type { HttpActionCtx } from "lunorash/server";

import { getAuth } from "../auth";
import { secretsMatch } from "../lib/crypto";

export const E2E_INVITATIONS_PATH = "/e2e/invitations";

/** An e2e invitation outlives any run, and is re-minted per test anyway. */
const EXPIRY_SECONDS = 24 * 60 * 60;

const BEARER_PREFIX = /^Bearer\s+/i;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"]);

const noStore = { "cache-control": "no-store" };

export interface TestInvitationEnvironment {
    environment: string;
    publicOrigin: string;
    token: string;
}

const isLoopbackOrigin = (origin: string): boolean => {
    try {
        return LOOPBACK_HOSTS.has(new URL(origin).hostname);
    } catch {
        return false;
    }
};

/** Whether this Worker may serve the route at all. Every condition must hold; see the module note. */
export const isTestInvitationRouteEnabled = ({ environment, publicOrigin, token }: TestInvitationEnvironment): boolean =>
    environment === "development" && isLoopbackOrigin(publicOrigin) && token.length > 0;

export interface TestInvitationDependencies {
    environment: () => TestInvitationEnvironment;
    /** Mints (or re-mints) the invitation for `email` and returns its plaintext token. */
    invite: (email: string) => Promise<string>;
}

/** The route, dependencies injected so the gate can be tested without a worker. */
export const createTestInvitationHandler =
    (dependencies: TestInvitationDependencies) =>
    async (request: Request): Promise<Response> => {
        const environment = dependencies.environment();

        if (!isTestInvitationRouteEnabled(environment)) {
            return new Response("Not Found", { headers: noStore, status: 404 });
        }

        const header = request.headers.get("authorization") ?? "";
        const presented = BEARER_PREFIX.test(header) ? header.replace(BEARER_PREFIX, "").trim() : "";

        if (!presented || !(await secretsMatch(presented, environment.token))) {
            return Response.json({ error: "Unauthorized" }, { headers: { ...noStore, "www-authenticate": "Bearer" }, status: 401 });
        }

        const body = (await request.json().catch(() => null)) as { email?: unknown } | null;
        const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";

        if (!email.includes("@")) {
            return Response.json({ error: "email is required" }, { headers: noStore, status: 400 });
        }

        return Response.json({ token: await dependencies.invite(email) }, { headers: noStore, status: 200 });
    };

export const e2eSeedInvitationHttpAction = async (_context: HttpActionCtx, request: Request): Promise<Response> =>
    await createTestInvitationHandler({
        environment: () => {
            return {
                environment: process.env.ENVIRONMENT ?? "",
                publicOrigin: process.env.PUBLIC_ORIGIN ?? "",
                token: process.env.E2E_SEED_TOKEN ?? "",
            };
        },
        invite: async (email) => {
            // Re-inviting replaces the token, which also re-opens a seat whose
            // invitation a previous run already spent.
            const invitation = await createSignUpInvitation(getAuth(), { email, expiresInSeconds: EXPIRY_SECONDS, invitedBy: "e2e" });

            return invitation.token;
        },
    })(request);
