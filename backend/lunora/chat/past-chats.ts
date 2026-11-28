import { DEFAULT_THREAD_TITLE } from "@neore/ai/constants";
import { v } from "lunorash/server";

import type { Id } from "../_generated/dataModel";
import { internal } from "../_generated/internal";
import { internalQuery } from "../_generated/server";
import type { ThreadDoc, TypedPromptRow } from "../agent/validators";
import { threadSharedWithOthers } from "../agent/live-grant";
import { isDeviceEligibleThread } from "../devices/internal";
import { MAX_LENGTH } from "../lib/validators";
import { isSearchIndexBuilding } from "../lib/search-index";
import { readMemoryEnabled } from "../memory/functions";
import { listsSentPrompts, sentPromptOf } from "./functions";
import { PAST_CHAT_RESULTS_DEFAULT, PAST_CHAT_RESULTS_MAX, pastChatSnippet, pastChatTitle } from "./lib/past-chat-snippet";
import { capSearchTerms, matchesQueryTerms, queryTerms } from "./lib/search-terms";
import { isTypedChatKind } from "./lib/typed-chat-kind";

/**
 * Index hits read before the filters, then once more with the wider window when too few survived: the current chat's
 * own prompt, branch copies and chats of another scope can take the first one. A hit past the wider window is not
 * searched. The same windows as the composer's prompt search.
 */
const PAST_CHAT_WINDOW = 100;
const PAST_CHAT_WINDOW_MAX = 400;
/** Thread lookups that run at once inside one search. */
const PAST_CHAT_LOOKUP_BATCH = 16;
/** Parent links followed from an untagged chat to the chat it was copied from; a deeper chain is no source. */
const PAST_CHAT_LINEAGE_DEPTH = 8;
/**
 * `threadRelationships` reads one search may make; past it an untagged chat is no source. Each untagged candidate still to be
 * judged keeps one of them, so a deep chain spends only what the others leave.
 */
const PAST_CHAT_LINEAGE_READS = 64;

const vPastChatHit = v.object({ sentAt: v.number(), snippet: v.string(), title: v.string() });

/** Chats a sub-agent or a worker runs in (`sub-agents/`): what they post goes to the chat that started them, not here. */
const CHILD_RUN_TAGS: ReadonlySet<string> = new Set(["sub-agent", "worker"]);
/**
 * Links only the server writes when it copies a chat's rows into a new one: a branch (`branchThread`) and a side chat
 * (`side-chat.ts`). A link the owner can write (`createThreadRelationshipPublic`: a comparison) proves no copy, so it
 * makes no chat a source; a comparison chat is tagged and needs no link.
 */
const COPY_LINKS: ReadonlySet<string | undefined> = new Set(["branch", "side"]);
/** A chat's links read to find a copy link; a chat with more is judged on these. */
const PAST_CHAT_LINKS_READ = 8;

/**
 * Why a search did not run: memory is off for the user (the same kind of recall, so it follows that setting), the chat it
 * would answer in is not the caller's alone (a shared, group, public or messenger chat, where others would read the
 * result), or it is a sub-agent's or worker's chat, whose result is posted to the chat that started it.
 */
const vPastChatUnavailable = v.union(v.literal("background_run"), v.literal("memory_off"), v.literal("not_private"));

/**
 * The caller's own words from earlier chats that match `query`, best match first, at most {@link PAST_CHAT_RESULTS_MAX}:
 * each hit is the chat's title, when the words were sent (the tool dates it in the user's timezone) and an excerpt of what the
 * person typed (`typedText`), never a reply, a tool result, an attachment or a page. It reads the typed-words index
 * through `typedTextSearch`, which drops every locked chat (no proof is passed), and keeps only prompts the composer's
 * search would list (`listsSentPrompts`: the caller's own chat, not trashed, deleted, locked or temporary;
 * `sentPromptOf`: a typed user row, no goal round), with no not-typed mark (a prompt link, an extension's relay, an admin
 * acting as the owner), and never the chat it answers in. Only chats a person types into are read (`isTypedChatKind`,
 * and their branches and side chats): a messenger, sub-agent, worker, task, trigger, eval or pull request chat is not. A bot chat reads that bot's chats and the user's chats with no
 * bot, as memory reads the bot's notes and the user's own; a chat with no bot (or one whose bot is gone) reads only chats
 * with no bot. A hit holds every word of the query (the last one also as the start of a longer word), as the index matches. Branch copies (the same words
 * sent at the same time) list once. `truncated` says the last index window was full and fewer hits than asked for were
 * found, so an older match may not have been searched. `preparing` says the index is still being built after a deploy, so nothing was searched yet.
 */
export const searchPastChats = internalQuery
    .input({
        limit: v.optional(v.number()),
        /** The caller's clock, so the query stays deterministic: a grant past its `expiresAt` shares nothing. */
        now: v.number(),
        query: v.string().max(MAX_LENGTH.long),
        threadId: v.id("threads"),
        userId: v.string().max(MAX_LENGTH.short),
    })
    .output(
        v.object({
            hits: v.array(vPastChatHit),
            preparing: v.optional(v.literal(true)),
            truncated: v.optional(v.literal(true)),
            unavailable: v.optional(vPastChatUnavailable),
        }),
    )
    .query(async ({ args: { limit, now, query, threadId, userId }, ctx: context }) => {
        if (!(await readMemoryEnabled(context, userId))) {
            context.log.event("chat.search_past_chats", { listed: 0, unavailable: "memory_off" });

            return { hits: [], unavailable: "memory_off" as const };
        }

        // The grants are read on the primary (`threadSharedWithOthers`): a replica may not yet hold one made a moment ago.
        const here = await context.db.get("threads", threadId);
        const current = isDeviceEligibleThread(here, userId, await threadSharedWithOthers(context, threadId, userId, now)) ? here : null;

        if (!current) {
            context.log.event("chat.search_past_chats", { listed: 0, unavailable: "not_private" });

            return { hits: [], unavailable: "not_private" as const };
        }

        // A sub-agent's or worker's chat passes the check above (the owner's alone), but its result is posted to the chat
        // that started it, which others may read.
        if ((current.tags ?? []).some((tag) => CHILD_RUN_TAGS.has(tag))) {
            context.log.event("chat.search_past_chats", { listed: 0, unavailable: "background_run" });

            return { hits: [], unavailable: "background_run" as const };
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
        const sources = new Map<string, boolean>();
        let lineageReads = 0;
        // Untagged candidates of the current window not judged yet: a walk reads past its own chat's links only while one read
        // stays for each of them, so chains ahead of a direct copy (one read from its source) cannot spend its read.
        const unjudged = new Set<string>();

        // A chat judged by itself, with no link read: a tagged or messenger chat by its kind, an import as no source.
        const judgedWithoutLinks = (thread: ThreadDoc): "no" | "yes" | undefined => {
            if ((thread.tags ?? []).length > 0 || thread.externalThreadId !== undefined || thread.messengerConnectionId !== undefined) {
                return isTypedChatKind(thread) ? "yes" : "no";
            }

            // An imported conversation (`chat-import/`) holds words typed elsewhere, whatever it is linked to.
            return thread.createdBy?.startsWith("import:") === true ? "no" : undefined;
        };

        const threadOf = async (id: string): Promise<ThreadDoc | null> => {
            if (!threads.has(id)) {
                threads.set(id, await context.runQuery(internal.agent.threads.getThreadInternal, { threadId: id as Id<"threads"> }));
            }

            return threads.get(id) ?? null;
        };

        // Whether a chat's prompts are the caller's typed words: a tagged chat by its kind; an untagged one (a branch or side
        // chat) as the chat it was copied from, and only while every chat on the way there is one the search may list
        // (`listsSentPrompts`): a branch made before its parent was locked, trashed or deleted holds that chat's prompts.
        // An import and a link of another kind are no source. A walk cut short by the depth or the read budget (and the reads
        // held back for the candidates still to judge) is no source for this search, but is not remembered as one: another
        // candidate may reach the same chat by a shorter way.
        const walkSource = async (thread: ThreadDoc, depth: number): Promise<"no" | "unknown" | "yes"> => {
            const known = judgedWithoutLinks(thread);

            if (known !== undefined) {
                return known;
            }

            const cached = sources.get(thread._id);

            if (cached !== undefined) {
                return cached ? "yes" : "no";
            }

            if (
                depth >= PAST_CHAT_LINEAGE_DEPTH ||
                lineageReads >= PAST_CHAT_LINEAGE_READS ||
                (depth > 0 && lineageReads + unjudged.size >= PAST_CHAT_LINEAGE_READS)
            ) {
                return "unknown";
            }

            lineageReads += 1;

            const links = await context.db
                .query("threadRelationships")
                .withIndex("by_thread", (q) => q.eq("threadId", thread._id as Id<"threads">))
                .take(PAST_CHAT_LINKS_READ);
            let verdict: "no" | "unknown" | "yes" = "no";

            // Any copy link to a source makes the chat one: a comparison link beside a branch's does not hide it.
            for (const link of links) {
                if (!COPY_LINKS.has(link.branchType) || (link.userId ?? userId) !== userId) {
                    continue;
                }

                const parent = await threadOf(link.parentThreadId);
                const parentVerdict = listsSentPrompts(parent, userId) ? await walkSource(parent, depth + 1) : "no";

                if (parentVerdict === "yes") {
                    verdict = "yes";
                    break;
                }

                if (parentVerdict === "unknown") {
                    verdict = "unknown";
                }
            }

            if (verdict !== "unknown") {
                sources.set(thread._id, verdict === "yes");
                unjudged.delete(thread._id);
            }

            return verdict;
        };
        const isTypedSource = async (thread: ThreadDoc): Promise<boolean> => {
            unjudged.delete(thread._id);

            return (await walkSource(thread, 0)) === "yes";
        };

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
            const listable = (thread: ThreadDoc | null): thread is ThreadDoc => listsSentPrompts(thread, userId) && inScope(thread);

            unjudged.clear();

            // Only a chat holding a row that is no repeat of an earlier one keeps a read: a copy of this chat's prompt, or a
            // branch whose every row an earlier chat already holds, is dropped by `seen` below unless that earlier row is not
            // listed, and then it is judged within what is left.
            const firstKeys = new Set(seen);

            for (const { message, typed: words } of elsewhere) {
                const key = copyKey(message, words);
                const thread = threads.get(message.threadId) ?? null;

                if (!firstKeys.has(key)) {
                    firstKeys.add(key);

                    if (listable(thread) && judgedWithoutLinks(thread) === undefined && !sources.has(thread._id)) {
                        unjudged.add(thread._id);
                    }
                }
            }

            for (const { message, typed: words } of elsewhere) {
                const thread = threads.get(message.threadId) ?? null;
                const key = copyKey(message, words);

                // A copy already listed (or of this chat's own prompt) is dropped before its chat is judged, so it reads nothing.
                if (seen.has(key) || !listable(thread) || !(await isTypedSource(thread))) {
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

            // A full window with every asked-for hit found is a complete answer; only one that came up short may be missing some.
            const truncated = filled && hits.length < wanted;

            context.log.event("chat.search_past_chats", { listed: hits.length, truncated, widened });

            return truncated ? { hits, truncated: true as const } : { hits };
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
