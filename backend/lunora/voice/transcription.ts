/**
 * Voice input for the mobile composer: one recorded clip in, its text out,
 * through the LLM gateway (`/internal/transcription`). The audio and the text
 * are saved NOWHERE here — the client puts the text into its draft, and the
 * person decides whether to send it.
 *
 * Metering, in the order it runs:
 * - guests are refused, as for spoken replies and realtime dictation;
 * - `voice/transcribe` per-minute calls (middleware);
 * - a per-clip cap on size (`MAX_CLIP_BASE64`) and stated length (`MAX_CLIP_SECONDS`);
 * - `voice/dailyTranscribeSeconds`, charged with the clip's stated seconds, before the call;
 * - the gateway reports the cost of the seconds the provider measured, which is
 *   deducted from the user's credits; on the user's own OpenAI key it is billed `byok`.
 */
import { LunoraError, v } from "lunorash/server";

import { internal } from "../_generated/internal";
import { isPlatformAdmin } from "../chat/lib/daily-limit";
import { authAction, rateLimit } from "../lib/crpc";
import { assertOk, fetchWithDeadline } from "../lib/fetch-timeout";
import { getRateLimitKey, getUserTier } from "../lib/rate-limiter";
import { gatewayFetch, SERVICE_ORIGIN } from "../lib/services";

/** Longest clip one call takes. The app stops recording here. */
export const MAX_CLIP_SECONDS = 60;

/** A minute of the app's 32 kbit/s mono recording is about 320 KB as base64; this leaves room for a higher bitrate. */
export const MAX_CLIP_BASE64 = 1_500_000;

/** Above the gateway's own 45s provider deadline. */
const TRANSCRIPTION_TIMEOUT_MS = 50_000;

export const TRANSCRIPTION_GUEST_MESSAGE = "Create an account to use voice input.";

export const TRANSCRIPTION_DAILY_LIMIT_MESSAGE = "You've used today's voice input allowance. Type your message, or try again tomorrow.";

export const transcribeClip = authAction
    .use(rateLimit("voice/transcribe"))
    .input({
        /** The recorded clip, base64. The format is read from its bytes. Sensitive: kept out of request logs. */
        audio: v.sensitive(v.string().check((value) => value.length > 0 && value.length <= MAX_CLIP_BASE64, { message: "The recording is too long" })),
        /** How long the recording ran, as the phone measured it. */
        durationMs: v.number().check((value) => value > 0 && value <= MAX_CLIP_SECONDS * 1000 + 1000, { message: "The recording is too long" }),
    })
    .output(v.object({ text: v.string() }))
    .action(async ({ args, ctx }) => {
        const { userId } = ctx.user;
        const seconds = Math.ceil(args.durationMs / 1000);

        // The identity does not carry `isAnonymous`; the user row does.
        const flags = await ctx.runQuery(internal.auth.functions.getUserAuthFlagsQuery, { userId });

        if (flags.isAnonymous) {
            throw new LunoraError("FORBIDDEN", TRANSCRIPTION_GUEST_MESSAGE);
        }

        if (!isPlatformAdmin({ role: flags.role })) {
            const tier = getUserTier({ plan: ctx.user.plan ?? null }) === "premium" ? "premium" : "free";
            const charge = await ctx.runMutation(internal.lib.rate_limiter_mutations.applyRateLimit, {
                count: seconds,
                identifier: userId,
                key: getRateLimitKey("voice/dailyTranscribeSeconds", tier),
            });

            if (!charge.ok) {
                throw new LunoraError("TOO_MANY_REQUESTS", TRANSCRIPTION_DAILY_LIMIT_MESSAGE, {
                    data: { code: "TOO_MANY_REQUESTS", message: TRANSCRIPTION_DAILY_LIMIT_MESSAGE, retryAfter: charge.retryAfter },
                });
            }
        }

        const providerKeys = await ctx.runQuery(internal.auth.functions.getDecryptedProviderKeysQuery, { userId });
        const response = await fetchWithDeadline(`${SERVICE_ORIGIN.llmGateway}/internal/transcription`, {
            body: JSON.stringify({
                audio: args.audio,
                durationSeconds: seconds,
                providerApiKey: providerKeys.openai || undefined,
                requestId: crypto.randomUUID(),
                userId,
            }),
            headers: { "Content-Type": "application/json" },
            method: "POST",
            timeoutMs: TRANSCRIPTION_TIMEOUT_MS,
            via: gatewayFetch(ctx),
        });

        await assertOk(response, "Transcription gateway error");

        const { text } = (await response.json()) as { text?: unknown };

        // Lengths only: neither the audio nor the words are logged.
        ctx.log.event("voice.transcribe", { chars: typeof text === "string" ? text.length : 0, seconds, userId });

        return { text: typeof text === "string" ? text.trim() : "" };
    });
