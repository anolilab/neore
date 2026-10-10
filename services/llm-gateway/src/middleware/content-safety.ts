/**
 * Content safety middleware — banned-words check for user prompts.
 *
 * Uses `@visulima/content-safety` to detect profanity, slurs, and hate speech
 * in user messages before forwarding to LLM providers.
 *
 * Applied to /internal/* endpoints that accept user text (stream, generate, model/proxy).
 * In Cloudflare Workers the 316KB module-init cost is a non-issue. It was a problem under
 * the previous backend, whose 2s module-init timeout this check used to have to fit inside;
 * that constraint is gone.
 */
import { createChecker } from "@visulima/content-safety";
import { createMiddleware } from "hono/factory";

import type { HonoEnv } from "../env.js";

/**
 * Ordinary English words that collide with an entry in ANOTHER language's list.
 *
 * Every dictionary is scanned at once (the gateway does not know the user's
 * language), so a French or Turkish entry spelled like an English word blocks
 * plain English: "chat" (fr) rejected this product's own title-generation
 * prompt, "does" (fr) rejected "What does this do?", "got" (tr) "I got it".
 * Each word here is harmless in English and appears in no `en` list, so the
 * filter's intent — profanity, slurs, hate speech — is unchanged. Found by
 * scanning the Latin-script entries of every non-`en` list; extend it the same
 * way rather than restricting `languages`, which would drop real non-English
 * matches.
 *
 * The two numerals are entries too — matched against the DICTIONARY spelling,
 * hence zh's "13." with its dot. They blocked every user message holding the
 * number, and the title prompt (which carries the local time) for the whole
 * 13:00 and 18:00 hour every day. The `en` numeric codes (1488, 14/88) stay.
 */
export const CROSS_LANGUAGE_ALLOWLIST: ReadonlyArray<string> = [
    "13.",
    "18",
    "air",
    "airy",
    "am",
    "bad",
    "bat",
    "batch",
    "bite",
    "bites",
    "bout",
    "bride",
    "brides",
    "cave",
    "chat",
    "chinchilla",
    "christ",
    "coin",
    "con",
    "cons",
    "crime",
    "crucifix",
    "del",
    "deportation",
    "does",
    "fan",
    "game",
    "got",
    "gotten",
    "http",
    "india",
    "jockey",
    "kiss",
    "latter",
    "mama",
    "melon",
    "melons",
    "meme",
    "mince",
    "minus",
    "miserable",
    "moss",
    "oral",
    "penchant",
    "pet",
    "pic",
    "pine",
    "pipe",
    "piranha",
    "piranhas",
    "plume",
    "pot",
    "rage",
    "rosette",
    "sacrament",
    "saint",
    "sieve",
    "tabernacle",
    "taper",
    "tool",
    "trainee",
    "trio",
    "zip",
    "zippy",
];

/** Built once per isolate; the lookup tables are constructed lazily on first check. */
const checker = createChecker({ allowlist: CROSS_LANGUAGE_ALLOWLIST });

/**
 * The message fields the extractors below read. Values stay `unknown` because
 * the body is unparsed JSON here — the runtime guards do the narrowing.
 */
interface WireMessage {
    content?: unknown;
    role?: unknown;
}

/** The fields the middleware reads off an `/internal/*` request body. */
interface SafetyRequestBody {
    callOptions?: { prompt?: unknown };
    messages?: unknown;
    system?: unknown;
}

/**
 * Extract user-visible text from a messages array.
 * Only scans user messages — assistant/tool/system messages are not user-authored.
 */
const extractUserText = (messages: WireMessage[]): string => {
    const texts: string[] = [];

    for (const message of messages) {
        if (message.role !== "user") continue;

        const { content } = message;

        if (typeof content === "string") {
            texts.push(content);
        } else if (Array.isArray(content)) {
            for (const part of content) {
                if (!(typeof part === "object" && part !== null && "type" in part)) {
                    continue;
                }

                const p = part as { text?: string; type: string };

                if (p.type === "text" && typeof p.text === "string") {
                    texts.push(p.text);
                }
            }
        }
    }

    return texts.join("\n");
};

/**
 * Extract user text from model-proxy callOptions (LanguageModelV3CallOptions).
 * The prompt field contains user/system/tool messages in AI SDK wire format.
 */
const extractTextFromCallOptions = (callOptions: { prompt?: unknown }): string => {
    const prompt = callOptions.prompt as WireMessage[] | undefined;

    if (!Array.isArray(prompt)) return "";

    return extractUserText(prompt);
};

/**
 * Middleware that checks request bodies for banned words.
 * Returns 400 BANNED_CONTENT with the same shape as the handler this replaced.
 */
export const contentSafetyMiddleware = createMiddleware<HonoEnv>(async (c, next) => {
    // Only check POST requests with JSON bodies
    if (c.req.method !== "POST") {
        return next();
    }

    const path = new URL(c.req.url).pathname;

    // Only apply to internal endpoints that accept user prompts
    if (!path.startsWith("/internal/")) {
        return next();
    }

    let textToCheck: string | undefined;

    try {
        // Clone the request body so downstream handlers can still read it.
        // Hono caches the parsed JSON internally, so c.req.json() works for both.
        const body = (await c.req.json()) as SafetyRequestBody;

        if (path === "/internal/model/proxy") {
            // Model proxy: user text is nested inside callOptions.prompt
            const { callOptions } = body;

            if (callOptions) {
                textToCheck = extractTextFromCallOptions(callOptions);
            }
        } else {
            // /internal/stream and /internal/generate: messages + system
            const messages = body.messages as WireMessage[] | undefined;
            const system = body.system as string | undefined;

            const parts: string[] = [];

            if (messages) {
                const userText = extractUserText(messages);

                if (userText) parts.push(userText);
            }

            if (system) {
                parts.push(system);
            }

            textToCheck = parts.join("\n");
        }
    } catch {
        // Body parse failed — let downstream validation handle it
        return next();
    }

    if (!textToCheck || textToCheck.length === 0) {
        return next();
    }

    const result = checker.check(textToCheck);

    if (result.hasBannedWords) {
        // Do NOT echo the matched words back. Returning the list would let
        // any HMAC-authed caller (or anyone who reaches this handler before
        // auth runs) probe for banned terms a few requests at a time and
        // reconstruct the wordlist. The opaque error code is enough for the
        // client to surface a generic block message.
        return c.json(
            {
                error: "BANNED_CONTENT",
                message: "Your message contains inappropriate content that cannot be sent.",
            },
            400,
        );
    }

    return next();
});
