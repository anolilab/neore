import { DEFAULT_THREAD_TITLE } from "@neore/ai/constants";
import { v } from "lunorash/server";

import type { Id } from "../_generated/dataModel";
import { internal } from "../_generated/internal";
import { internalQuery } from "../_generated/server";
import type { ThreadDoc, TypedPromptRow } from "../agent/validators";
import { loadEligibleThread } from "../devices/internal";
import { MAX_LENGTH } from "../lib/validators";
import { readMemoryEnabled } from "../memory/functions";
import { isSearchIndexBuilding, listsSentPrompts, sentPromptOf } from "./functions";
import { PAST_CHAT_RESULTS_DEFAULT, PAST_CHAT_RESULTS_MAX, pastChatSnippet, pastChatTitle } from "./lib/past-chat-snippet";
import { capSearchTerms, matchesQueryTerms, queryTerms } from "./lib/search-terms";

/**
 * Index hits read before the filters, then once more with the wider window when too few survived: the current chat's
 * own prompt, branch copies and chats of another scope can take the first one. A hit past the wider window is not
 * searched. The same windows as the composer's prompt search.
 */
const PAST_CHAT_WINDOW = 100;
const PAST_CHAT_WINDOW_MAX = 400;
/** Thread lookups that run at once inside one search. */
const PAST_CHAT_LOOKUP_BATCH = 16;

const vPastChatHit = v.object({ sentAt: v.number(), snippet: v.string(), title: v.string() });

/**
 * Why a search did not run: memory is off for the user (the same kind of recall, so it follows that setting), or the
 * chat it would answer in is not the caller's alone (a shared, group, public or messenger chat, where others would read
 * the result).
 */
const vPastChatUnavailable = v.union(v.literal("memory_off"), v.literal("not_private"));

/**
 * The caller's own words from earlier chats that match `query`, best match first, at most {@link PAST_CHAT_RESULTS_MAX}:
 * each hit is the chat's title, when the words were sent (the tool dates it in the user's timezone) and an excerpt of what the
 * person typed (`typedText`), never a reply, a tool result, an attachment or a page. It reads the typed-words index
 * through `typedTextSearch`, which drops every locked chat (no proof is passed), and keeps only prompts the composer's
 * search would list (`listsSentPrompts`: the caller's own chat, not trashed, deleted, locked or temporary;
 * `sentPromptOf`: a typed user row, no goal round), with no not-typed mark (a prompt link, an extension's relay, an admin
 * acting as the owner), and never the chat it answers in. A bot chat reads that bot's chats and the user's chats with no
 * bot, as memory reads the bot's notes and the user's own; a chat with no bot (or one whose bot is gone) reads only chats
 * with no bot. A hit holds every word of the query (the last one also as the start of a longer word), as the index matches. Branch copies (the same words
 * sent at the same time) list once. `preparing` says the index is still being built after a deploy, so nothing was
 * searched yet.
 */
export const searchPastChats = internalQuery
    .input({
        limit: v.optional(v.number()),
        query: v.string().max(MAX_LENGTH.long),
        threadId: v.id("threads"),
        userId: v.string().max(MAX_LENGTH.short),
    })
    .output(v.object({ hits: v.array(vPastChatHit), preparing: v.optional(v.literal(true)), unavailable: v.optional(vPastChatUnavailable) }))
    .query(async ({ args: { limit, query, threadId, userId }, ctx: context }) => {
        if (!(await readMemoryEnabled(context, userId))) {
            context.log.event("chat.search_past_chats", { listed: 0, unavailable: "memory_off" });

            return { hits: [], unavailable: "memory_off" as const };
        }

        const current = await loadEligibleThread(context, threadId, userId);

        if (!current) {
            context.log.event("chat.search_past_chats", { listed: 0, unavailable: "not_private" });

            return { hits: [], unavailable: "not_private" as const };
        }

        const text = capSearchTerms(query.trim().slice(0, MAX_LENGTH.short).trim());
        const terms = queryTerms(text);

        if (terms.length === 0) {
            context.log.event("chat.search_past_chats", { listed: 0, widened: false });

            return { hits: [] };
        }

        const wanted = Math.max(1, Math.min(PAST_CHAT_RESULTS_MAX, Math.floor(limit ?? PAST_CHAT_RESULTS_DEFAULT)));

        // A bot that is gone, or no longer the caller's, scopes nothing: the chat reads as one with no bot.
        const bot = current.botId ? await context.runQuery(internal.bots.functions.getBotForRun, { botId: current.botId, userId }) : null;
        const scopeBot = bot ? current.botId : undefined;
        const inScope = (thread: ThreadDoc): boolean => (thread.botId ?? null) === null || thread.botId === scopeBot;
        const threads = new Map<string, ThreadDoc | null>();

        const collect = async (window: number) => {
            const { filled, messages } = await context.runQuery(internal.agent.messages.typedTextSearch, { limit: window, text, userId });
            const typed = messages.flatMap((message) => {
                const prompt = sentPromptOf(message);

                // A prompt with a not-typed mark holds words the person did not write. Every query word must match, as the index does.
                return prompt !== undefined && prompt.draftFrom === undefined && matchesQueryTerms(prompt.typed, terms)
                    ? [{ message, typed: prompt.typed }]
                    : [];
            });
            const sentAt = (message: TypedPromptRow): number => message.createdAt ?? message._creationTime;
            // A branch copies its rows with the same words and send time: one hit per copy, and none for a copy of a prompt
            // of the chat this answers in (its parent's or a sibling branch's row).
            const copyKey = (message: TypedPromptRow, words: string): string => `${String(sentAt(message))}\u{0}${words}`;
            const seen = new Set(typed.filter(({ message }) => message.threadId === threadId).map(({ message, typed: words }) => copyKey(message, words)));
            const elsewhere = typed.filter(({ message }) => message.threadId !== threadId);
            const unseen = [...new Set(elsewhere.map(({ message }) => message.threadId))].filter((id) => !threads.has(id));

            for (let start = 0; start < unseen.length; start += PAST_CHAT_LOOKUP_BATCH) {
                const batch = unseen.slice(start, start + PAST_CHAT_LOOKUP_BATCH);
                const found = await Promise.all(
                    batch.map((id) => context.runQuery(internal.agent.threads.getThreadInternal, { threadId: id as Id<"threads"> })),
                );

                for (const [offset, id] of batch.entries()) {
                    threads.set(id, found[offset] ?? null);
                }
            }

            const hits: { sentAt: number; snippet: string; title: string }[] = [];

            for (const { message, typed: words } of elsewhere) {
                const thread = threads.get(message.threadId) ?? null;

                if (!listsSentPrompts(thread, userId) || !inScope(thread)) {
                    continue;
                }

                const key = copyKey(message, words);

                if (seen.has(key)) {
                    continue;
                }

                seen.add(key);
                hits.push({
                    sentAt: sentAt(message),
                    snippet: pastChatSnippet(words, terms),
                    title: pastChatTitle(thread.title ?? DEFAULT_THREAD_TITLE),
                });

                if (hits.length >= wanted) {
                    break;
                }
            }

            return { filled, hits };
        };

        try {
            let { filled, hits } = await collect(PAST_CHAT_WINDOW);
            const widened = filled && hits.length < wanted;

            if (widened) {
                ({ filled, hits } = await collect(PAST_CHAT_WINDOW_MAX));
            }

            context.log.event("chat.search_past_chats", { listed: hits.length, truncated: filled, widened });

            return { hits };
        } catch (error) {
            // After a deploy that adds `typed_text_search`, Lunora refuses the index until its backfill covers the existing
            // messages: "not ready yet", not a failure and not "no match".
            if (isSearchIndexBuilding(error)) {
                context.log.event("chat.search_past_chats", { listed: 0, preparing: true, widened: false });

                return { hits: [], preparing: true as const };
            }

            throw error;
        }
    });
