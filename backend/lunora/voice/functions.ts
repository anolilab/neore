import { LunoraError, v } from "lunorash/server";

import { authMutation, rateLimit } from "../lib/crpc";

/**
 * Authorizes the web app's `/api/scribe-token` route to mint ONE paid
 * ElevenLabs realtime-dictation token for the caller. The route holds the
 * ElevenLabs key and calls this first with the caller's session; the key never
 * reaches the backend or the browser.
 *
 * Anonymous (guest) sessions are refused — the composer falls back to the Web
 * Speech API for them — and signed-in users are metered by
 * `voice/scribeToken`, so a script cannot turn the route into an unmetered
 * ElevenLabs proxy.
 */
export const authorizeScribeToken = authMutation
    .use(rateLimit("voice/scribeToken"))
    .output(v.null())
    .mutation(async ({ ctx }) => {
        const userDocument = await ctx.db.user.findFirst({ where: { _id: ctx.db.asId("user", ctx.user.userId) } });

        if (!userDocument || userDocument.isAnonymous === true) {
            throw new LunoraError("FORBIDDEN", "Realtime dictation requires an account");
        }

        ctx.log.event("voice.authorize_scribe_token", { authorized: true });

        return null;
    });
