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
 * - `voice/dailyTranscribeSeconds`, charged before the call with the clip's stated seconds or, when more, the
 *   seconds its size implies at the app's bitrate (the phone's figure is not trusted alone); after the call, any
 *   seconds the provider measured beyond that are charged too;
 * - the gateway reports the cost of the seconds the provider measured, which is
 *   deducted from the user's credits; on the user's own OpenAI key it is billed `byok`.
 */
import { LunoraError, v } from "lunorash/server";

import { internal } from "../_generated/internal";
import { isPlatformAdmin } from "../chat/lib/daily-limit";
import { authAction, rateLimit } from "../lib/crpc";
import { assertOk, fetchWithDeadline } from "../lib/fetch-timeout";
import { logger } from "../lib/logger";
import { getRateLimitKey, getUserTier } from "../lib/rate-limiter";
import { gatewayFetch, SERVICE_ORIGIN } from "../lib/services";

/** Longest clip one call takes. The app stops recording here. */
export const MAX_CLIP_SECONDS = 60;

/**
 * A minute of the app's 32 kbit/s mono recording is about 320 KB as base64; this leaves room for container overhead.
 * The clip rides in the RPC body rather than the upload route on purpose: an upload is staged in storage, and the audio
 * must not be stored. This cap keeps it well under the 1 MiB RPC body limit.
 */
export const MAX_CLIP_BASE64 = 600_000;

/** The app records at 32 kbit/s: a clip's size sets a floor on the seconds charged before the call. */
const CLIP_BYTES_PER_SECOND = 4000;

/** The seconds charged up front: the stated length, or what the size implies when that is more. */
export const chargedSeconds = (audioBase64Length: number, durationMs: number): number =>
    Math.max(Math.ceil(durationMs / 1000), Math.ceil((audioBase64Length * 3) / 4 / CLIP_BYTES_PER_SECOND));

const voiceLogger = logger.scope("voice");

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
        const seconds = chargedSeconds(args.audio.length, args.durationMs);

        // The identity does not carry `isAnonymous`; the user row does.
        const flags = await ctx.runQuery(internal.auth.functions.getUserAuthFlagsQuery, { userId });

        if (flags.isAnonymous) {
            throw new LunoraError("FORBIDDEN", TRANSCRIPTION_GUEST_MESSAGE);
        }

        const isMetered = !isPlatformAdmin({ role: flags.role });
        const dailyKey = getRateLimitKey("voice/dailyTranscribeSeconds", getUserTier({ plan: ctx.user.plan ?? null }) === "premium" ? "premium" : "free");

        if (isMetered) {
            const charge = await ctx.runMutation(internal.lib.rate_limiter_mutations.applyRateLimit, { count: seconds, identifier: userId, key: dailyKey });

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
                // The credits are the member's in the active organization, from the session, never from the client.
                orgId: ctx.user.activeOrganization?.id,
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

        const { seconds: measured, text } = (await response.json()) as { seconds?: unknown; text?: unknown };
        const extra = typeof measured === "number" ? Math.ceil(measured) - seconds : 0;

        // The provider heard more than was charged (a clip at a lower bitrate than the app's): book the rest as debt, so
        // this call still answers and the next ones are refused. It never fails the call: the provider is already paid.
        if (isMetered && extra > 0) {
            try {
                await ctx.runMutation(internal.lib.rate_limiter_mutations.applyRateLimit, { count: extra, identifier: userId, key: dailyKey, reserve: true });
            } catch (error) {
                // The rate limiter's error: no audio, text or user id in it.
                voiceLogger.error("Could not book the measured transcription seconds", { error, extra });
                ctx.log.event("voice.transcribe_post_charge_failed", { error: error instanceof Error ? error.message : String(error), extra });
            }
        }

        // Lengths only: neither the audio, the words nor who spoke them are logged.
        ctx.log.event("voice.transcribe", { chars: typeof text === "string" ? text.length : 0, seconds });

        return { text: typeof text === "string" ? text.trim() : "" };
    });
