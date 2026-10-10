/**
 * The "Translate" message action: one short utility-model call, routed through
 * the LLM gateway (`getUtilityModel`), cached in `actionCache` per user,
 * message, language and text, and rate-limited in its own `chat/translate`
 * family so it does not spend the prompt optimizer's budget. The flow itself is
 * `lib/translate-message.ts`.
 *
 * The text is the client's, so a unique string always misses the cache: every
 * miss is a model call, and is charged to the caller's DAILY text quota like a
 * chat message (`chargeDailyLimit`), with an output budget scaled to the text.
 * Guests cannot translate — their quota is for trying the chat.
 */
import { generateText } from "ai";
import { LunoraError, v } from "lunorash/server";

import { internal } from "../_generated/internal";
import { authAction, rateLimit } from "../lib/crpc";
import { gatewayFetch } from "../lib/services";
import { getUtilityModel } from "../lib/utility-model";
import {
    MAX_LANGUAGE_TAG_LENGTH,
    MAX_MESSAGE_ID_LENGTH,
    MAX_TRANSLATE_CHARS,
    TRANSLATION_CACHE_NAME,
    TRANSLATION_CACHE_TTL_MS,
    TranslateInputError,
    translateWithCache,
    translationOutputTokens,
} from "./lib/translate-message";
import { chargeDailyLimit } from "./lib/daily-limit";

/** A translation of a long reply takes a while; a hung gateway must not hold the action forever. */
const TRANSLATE_TIMEOUT_MS = 60_000;

export const TRANSLATE_GUEST_MESSAGE = "Create an account to translate messages.";

const TRANSLATE_DAILY_LIMIT_MESSAGE = "You've reached your daily message limit. Translation is available again tomorrow.";

export const translateMessage = authAction
    .use(rateLimit("chat/translate"))
    .input({
        /** The message the text belongs to; part of the cache key only. */
        messageId: v.string().check((value) => value.length <= MAX_MESSAGE_ID_LENGTH, { message: "Invalid message id" }),
        /** BCP 47 tag, e.g. `de` or `pt-BR`. */
        targetLanguage: v.string().check((value) => value.length <= MAX_LANGUAGE_TAG_LENGTH, { message: "Unsupported target language" }),
        /** What the message shows. The trimmed text is checked against the same bound. */
        text: v.string().check((value) => value.length <= MAX_TRANSLATE_CHARS * 2, { message: "Text is too long to translate" }),
    })
    .output(v.object({ cached: v.boolean(), targetLanguage: v.string(), translation: v.string() }))
    .action(async ({ args, ctx }) => {
        const { plan, role, userId } = ctx.user;
        // The identity does not carry `isAnonymous`; the user row does.
        const flags = await ctx.runQuery(internal.auth.functions.getUserAuthFlagsQuery, { userId });

        if (flags.isAnonymous) {
            throw new LunoraError("FORBIDDEN", TRANSLATE_GUEST_MESSAGE);
        }

        try {
            const result = await translateWithCache(
                {
                    cacheGet: async (key) => {
                        const cached = await ctx.runQuery(internal.lib.action_cache.get, { key, now: Date.now() });

                        return cached.kind === "hit" && typeof cached.value === "string" ? cached.value : null;
                    },
                    cachePut: async (key, translation) => {
                        // A lost cache write costs a repeat call later, never this one.
                        await ctx
                            .runMutation(internal.lib.action_cache.put, {
                                key,
                                name: TRANSLATION_CACHE_NAME,
                                ttl: TRANSLATION_CACHE_TTL_MS,
                                value: translation,
                            })
                            .catch(() => undefined);
                    },
                    translate: async ({ prompt, system }) => {
                        // Only a cache miss reaches here, so only a model call is charged.
                        const charge = await chargeDailyLimit(ctx, { _id: userId, isAnonymous: false, plan: plan ?? null, role: role ?? null }, "Text");

                        if (!charge.ok) {
                            throw new LunoraError("TOO_MANY_REQUESTS", TRANSLATE_DAILY_LIMIT_MESSAGE, {
                                data: { code: "TOO_MANY_REQUESTS", message: TRANSLATE_DAILY_LIMIT_MESSAGE, retryAfter: charge.retryAfter },
                            });
                        }

                        const { text } = await generateText({
                            abortSignal: AbortSignal.timeout(TRANSLATE_TIMEOUT_MS),
                            maxOutputTokens: translationOutputTokens(args.text),
                            model: await getUtilityModel(gatewayFetch(ctx), { userId }),
                            prompt,
                            system,
                            temperature: 0.2,
                        });

                        return text;
                    },
                },
                { ...args, userId },
            );

            ctx.log.event("chat.translate", { cached: result.cached, chars: args.text.length, targetLanguage: result.targetLanguage, userId });

            return result;
        } catch (error) {
            if (error instanceof TranslateInputError) {
                throw new LunoraError("BAD_REQUEST", error.message);
            }

            throw error;
        }
    });
