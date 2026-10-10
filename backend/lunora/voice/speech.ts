/**
 * Speech for hands-free voice mode: one registry TTS call through the LLM
 * gateway (`/internal/speech`), returned to the caller and saved NOWHERE — no
 * message, no file. `chat_functions.generateAudio` is the other TTS path and is
 * the wrong one here: it appends an audio message to the thread every turn and
 * draws on the 5/day audio quota.
 *
 * Metering, in the order it runs:
 * - guests are refused (as for realtime dictation and translation) — the web
 *   client falls back to the browser's own voice for them;
 * - `voice/speech` per-minute calls (middleware);
 * - a per-request cap, `MAX_SPEECH_CHARS` — the client sends a reply a few
 *   sentences at a time;
 * - `voice/dailySpeechChars`, charged with the text's LENGTH, before the call;
 * - the gateway reports the call's per-character cost, which is deducted from
 *   the user's credits (`auth_billing.deductCreditsFromGateway`); on the user's
 *   own FAL key it is billed `byok`.
 */
import { DEFAULT_SPEECH_MODEL } from "@neore/ai/models";
import { LunoraError, v } from "lunorash/server";

import { internal } from "../_generated/internal";
import { isPlatformAdmin } from "../chat/lib/daily-limit";
import { authAction, rateLimit } from "../lib/crpc";
import { bytesToBase64 } from "../lib/crypto";
import { assertOk, fetchWithDeadline } from "../lib/fetch-timeout";
import { getRateLimitKey, getUserTier } from "../lib/rate-limiter";
import { gatewayFetch, SERVICE_ORIGIN } from "../lib/services";

/** Longest text one call synthesises. A few sentences: the client splits a reply so playback starts early. */
export const MAX_SPEECH_CHARS = 1000;

/** Longest voice id accepted; the gateway falls back to the model's default for one it does not know. */
export const MAX_SPEECH_VOICE_LENGTH = 100;

/** A FAL render of a few sentences takes seconds; above the gateway's own 45s provider deadline. */
const SPEECH_TIMEOUT_MS = 50_000;

export const SPEECH_GUEST_MESSAGE = "Create an account to use spoken replies.";

export const SPEECH_DAILY_LIMIT_MESSAGE = "You've used today's spoken-reply allowance. Replies are read with your browser's voice until tomorrow.";

export const synthesizeSpeech = authAction
    .use(rateLimit("voice/speech"))
    .input({
        /** Plain text to speak — the client strips Markdown first. Trimmed, then checked against `MAX_SPEECH_CHARS`. */
        text: v.string().check((value) => value.length <= MAX_SPEECH_CHARS * 2, { message: "Text is too long to speak" }),
        /** A preset voice id of the speech model (a skill's `voice`, or the user's default). */
        voice: v.optional(v.string().check((value) => value.length <= MAX_SPEECH_VOICE_LENGTH, { message: "Invalid voice" })),
    })
    .output(v.object({ audio: v.string(), mimeType: v.string() }))
    .action(async ({ args, ctx }) => {
        const { userId } = ctx.user;
        const text = args.text.trim();

        if (text.length === 0) {
            throw new LunoraError("BAD_REQUEST", "Nothing to speak");
        }

        if (text.length > MAX_SPEECH_CHARS) {
            throw new LunoraError("BAD_REQUEST", `Text is too long to speak (max ${String(MAX_SPEECH_CHARS)} characters)`);
        }

        // The identity does not carry `isAnonymous`; the user row does.
        const flags = await ctx.runQuery(internal.auth.functions.getUserAuthFlagsQuery, { userId });

        if (flags.isAnonymous) {
            throw new LunoraError("FORBIDDEN", SPEECH_GUEST_MESSAGE);
        }

        if (!isPlatformAdmin({ role: flags.role })) {
            const tier = getUserTier({ plan: ctx.user.plan ?? null }) === "premium" ? "premium" : "free";
            const charge = await ctx.runMutation(internal.lib.rate_limiter_mutations.applyRateLimit, {
                count: text.length,
                identifier: userId,
                key: getRateLimitKey("voice/dailySpeechChars", tier),
            });

            if (!charge.ok) {
                throw new LunoraError("TOO_MANY_REQUESTS", SPEECH_DAILY_LIMIT_MESSAGE, {
                    data: { code: "TOO_MANY_REQUESTS", message: SPEECH_DAILY_LIMIT_MESSAGE, retryAfter: charge.retryAfter },
                });
            }
        }

        const providerKeys = await ctx.runQuery(internal.auth.functions.getDecryptedProviderKeysQuery, { userId });
        const response = await fetchWithDeadline(`${SERVICE_ORIGIN.llmGateway}/internal/speech`, {
            body: JSON.stringify({
                modelId: DEFAULT_SPEECH_MODEL,
                providerApiKey: providerKeys.fal || undefined,
                requestId: crypto.randomUUID(),
                text,
                userId,
                voice: args.voice?.trim() || undefined,
            }),
            headers: { "Content-Type": "application/json" },
            method: "POST",
            timeoutMs: SPEECH_TIMEOUT_MS,
            via: gatewayFetch(ctx),
        });

        await assertOk(response, "Speech gateway error");

        const audio = new Uint8Array(await response.arrayBuffer());

        ctx.log.event("voice.speech", { bytes: audio.byteLength, chars: text.length, userId });

        return { audio: bytesToBase64(audio), mimeType: response.headers.get("content-type") ?? "audio/mpeg" };
    });
