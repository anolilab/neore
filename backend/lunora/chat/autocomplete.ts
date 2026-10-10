/**
 * Composer autocomplete ("ghost text"): one tiny utility-model call per pause
 * in typing, routed through the LLM gateway (`getUtilityModel`) and rate-limited
 * in its own `chat/autocomplete` family so it never spends the prompt
 * optimizer's or translate's budget. OPT-IN (`userSettings.composerAutocompleteEnabled`,
 * absent = off) and checked here too, not only in the UI: every call sends the
 * user's draft to a model.
 *
 * Not charged in credits, like the other small helpers (titles, follow-up
 * suggestions, translate); the gateway still meters it per user.
 *
 * The flow's pure part (prompt, bounds, clean-up) is `lib/autocomplete.ts`.
 */
import { generateText } from "ai";
import { LunoraError, v } from "lunorash/server";

import { internal } from "../_generated/internal";
import { internalQuery } from "../_generated/server";
import { authAction, rateLimit } from "../lib/crpc";
import { chatLogger } from "../lib/logger";
import { gatewayFetch } from "../lib/services";
import { getUtilityModel } from "../lib/utility-model";
import { autocompleteContext, buildAutocompletePrompt, cleanCompletion, MAX_AUTOCOMPLETE_ARG_CHARS, MIN_AUTOCOMPLETE_CHARS } from "./lib/autocomplete";

/** A suggestion that arrives later than this is no longer wanted; the user has typed on. */
const AUTOCOMPLETE_TIMEOUT_MS = 3000;

/** A few words. */
const MAX_OUTPUT_TOKENS = 32;

export const isComposerAutocompleteEnabled = internalQuery
    .input({ userId: v.string() })
    .output(v.boolean())
    .query(async ({ args: { userId }, ctx }) => {
        const settings = await ctx.db
            .query("userSettings")
            .withIndex("by_userId", (q) => q.eq("userId", userId))
            .unique();

        // OPT-IN: absent means off.
        return settings?.composerAutocompleteEnabled === true;
    });

export const suggestCompletion = authAction
    .use(rateLimit("chat/autocomplete"))
    .input({
        /** The draft up to the caret (the caret must be at its end). Only its tail is used. */
        text: v.string().check((value) => value.length <= MAX_AUTOCOMPLETE_ARG_CHARS, { message: "Text is too long" }),
    })
    .output(v.object({ completion: v.string() }))
    .action(async ({ args: { text }, ctx }) => {
        const { userId } = ctx.user;

        const enabled = await ctx.runQuery(internal.chat.autocomplete.isComposerAutocompleteEnabled, { userId });

        if (!enabled) {
            throw new LunoraError("FORBIDDEN", "Composer autocomplete is turned off");
        }

        const draft = autocompleteContext(text);

        if (draft.trim().length < MIN_AUTOCOMPLETE_CHARS) {
            return { completion: "" };
        }

        const { prompt, system } = buildAutocompletePrompt(draft);

        try {
            const result = await generateText({
                abortSignal: AbortSignal.timeout(AUTOCOMPLETE_TIMEOUT_MS),
                maxOutputTokens: MAX_OUTPUT_TOKENS,
                maxRetries: 0,
                model: await getUtilityModel(gatewayFetch(ctx), { userId }),
                prompt,
                system,
                temperature: 0.2,
            });

            const completion = cleanCompletion(draft, result.text);

            // Lengths only: the draft is the user's own words and stays out of the logs.
            ctx.log.event("chat.autocomplete", { chars: draft.length, completionChars: completion.length, userId });

            return { completion };
        } catch (error) {
            // A missing ghost is the whole failure mode: a timeout or a gateway
            // error must not surface as an error on every pause in typing.
            chatLogger.warn("[suggestCompletion] completion failed", { error: error instanceof Error ? error.message : String(error) });

            return { completion: "" };
        }
    });
