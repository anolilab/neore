import type { ReturnOf } from "@lunora/react";
import { api } from "@neore/backend/api";

import { ago, DAY, HOUR, MINUTE, STORY_NOW } from "../clock";
import type { LunoraFixture } from "../lunora";
import { lunora } from "../lunora";
import { OWNER, ownedBy } from "./owner";

type Thread = NonNullable<ReturnOf<typeof api.chat.functions.getThread>>;
type ThreadList = ReturnOf<typeof api.chat.composite.getThreadListData>;
type ThreadListItem = ThreadList["threads"]["page"][number];
export type ChatMessage = ReturnOf<typeof api.chat.functions.getThreadUIMessages>["page"][number];

/** A page of a paginated query, complete. */
export const pageOf = <T>(items: T[]) => {
    return { continueCursor: "", isDone: true, page: items };
};

/** Thread ids are UUIDs (`isLunoraId`); these are stable so a page story can name its URL. */
export const THREAD_IDS = {
    main: "0193c1b2-7d1e-7a3c-9f00-000000000001",
    pinned: "0193c1b2-7d1e-7a3c-9f00-000000000002",
    recent: "0193c1b2-7d1e-7a3c-9f00-000000000003",
    older: "0193c1b2-7d1e-7a3c-9f00-000000000004",
    project: "0193c1b2-7d1e-7a3c-9f00-000000000005",
} as const;

export const thread = (overrides: Partial<Thread> & { _id: string }): Thread => {
    return {
        _creationTime: ago(2 * DAY),
        createdAt: ago(2 * DAY),
        lastReplyAt: ago(HOUR),
        model: "anthropic/claude-sonnet-4.5",
        status: "active",
        title: "Untitled",
        updatedAt: ago(HOUR),
        // The signed-in persona owns the mock threads, whichever persona is shown.
        userId: OWNER,
        ...overrides,
    } as Thread;
};

export const THREADS = {
    main: thread({ _id: THREAD_IDS.main, title: "Plan the Q1 product launch" }),
    older: thread({ _id: THREAD_IDS.older, lastReplyAt: ago(9 * DAY), title: "Rust lifetimes, explained", updatedAt: ago(9 * DAY) }),
    pinned: thread({ _id: THREAD_IDS.pinned, pinnedAt: ago(DAY), title: "Weekly team update draft" }),
    project: thread({ _id: THREAD_IDS.project, projectId: "project_launch", title: "Pricing page copy" }),
    recent: thread({ _id: THREAD_IDS.recent, lastReplyAt: ago(26 * HOUR), title: "Fix flaky Playwright test", updatedAt: ago(26 * HOUR) }),
} satisfies Record<string, Thread>;

let messageOrder = 0;

const message = (role: "assistant" | "user", text: string, order: number, extra: Partial<ChatMessage> = {}): ChatMessage => {
    messageOrder += 1;

    return {
        _creationTime: STORY_NOW - (100 - order) * MINUTE,
        id: `message_${String(order)}_${role}_${String(messageOrder)}`,
        key: `${THREAD_IDS.main}-${String(order)}-${role}`,
        order,
        parts: [{ state: "done", text, type: "text" }],
        role,
        status: "success",
        stepOrder: role === "user" ? 0 : 1,
        text,
        ...extra,
    } as ChatMessage;
};

export const userMessage = (text: string, order: number): ChatMessage => message("user", text, order, { userId: OWNER });

export const assistantMessage = (text: string, order: number, extra: Partial<ChatMessage> & { reasoning?: string } = {}): ChatMessage => {
    const { reasoning, ...rest } = extra;
    const reply = message("assistant", text, order, { model: "anthropic/claude-sonnet-4.5", ...rest });

    return reasoning ? ({ ...reply, parts: [{ state: "done", text: reasoning, type: "reasoning" }, ...reply.parts] } as ChatMessage) : reply;
};

/** A short conversation with Markdown, a list and code, which most chat stories start from. */
export const CONVERSATION: ChatMessage[] = [
    userMessage("Help me plan the Q1 launch. We have six weeks and three engineers.", 0),
    assistantMessage(
        [
            "Here is a plan that fits six weeks with three engineers:",
            "",
            "1. **Weeks 1–2: scope.** Freeze the feature list and write the launch checklist.",
            "2. **Weeks 3–4: build.** One engineer per track: onboarding, billing, docs.",
            "3. **Weeks 5–6: harden.** Bug bash, load test, and a staged rollout.",
            "",
            "```ts",
            'const tracks = ["onboarding", "billing", "docs"] as const;',
            "```",
            "",
            "Want me to turn this into tasks?",
        ].join("\n"),
        0,
        { reasoning: "Six weeks, three people: split into scope, build and harden, two weeks each." },
    ),
    userMessage("Yes, and add owners.", 1),
    assistantMessage("Done: each track has an owner and a due date. Onboarding goes to Ada, billing to Sam, docs to Grace.", 1),
];

const listItem = (value: Thread): ThreadListItem => value as unknown as ThreadListItem;

/** The sidebar's thread list: pinned, today, yesterday and older, plus one project thread. */
export const threadList = (threads: Thread[] = Object.values(THREADS)): ThreadList => {
    return {
        pinnedThreads: threads.filter((item) => item.pinnedAt !== undefined).map(listItem),
        relationships: [],
        tags: [],
        temporaryThreads: pageOf([]),
        threads: pageOf(threads.map(listItem)),
    } as unknown as ThreadList;
};

type ActiveStream = NonNullable<ReturnOf<typeof api.chat.streaming.getActiveStreamForThread>>;

export const STREAM_ID = "0193c1b2-7d1e-7a3c-9f00-0000000000aa" as ActiveStream["streamId"];

type StreamBody = ReturnOf<typeof api.chat.streaming.getStreamBody>;

/**
 * The reply of an active stream as `getStreamBody` returns it while the thread polls the
 * saved chunks (a stream this page did not start). Each read reveals `wordsPerRead` more
 * words, reasoning first; `hang` stops short of `done`, the "still generating" state.
 */
export const streamingBody = (text: string, options: { hang?: boolean; reasoning?: string; wordsPerRead?: number } = {}) => {
    const words = text.split(/(?<=\s)/u);
    let shown = 0;

    return (): StreamBody => {
        shown = Math.min(words.length, shown + (options.wordsPerRead ?? 3));

        const done = shown === words.length && !options.hang;

        return { reasoning: options.reasoning ?? "", status: done ? "done" : "streaming", text: words.slice(0, shown).join("") } as StreamBody;
    };
};

interface ChatFixtureOptions {
    /** A reply in progress (with `streamBody`), or one paused by a rate limit (`pause`). */
    activeStream?: Partial<ActiveStream>;
    /** What the active stream has produced so far; see `streamingBody`. */
    streamBody?: () => StreamBody;
    messages?: ChatMessage[];
    permission?: "admin" | "read" | "write";
    suggestions?: string[];
    thread?: Thread;
    threads?: Thread[];
}

/**
 * What the chat layout and a thread read: the sidebar list, projects, the thread, its messages
 * (both the composite first-paint read and the paginated one), shard routing and the slide
 * generator. Messages are STATEFUL like the user fixtures: a story can append to the array it
 * passed and the next poll shows it.
 */
export const chatFixtures = (options: ChatFixtureOptions = {}): LunoraFixture[] => {
    const current = options.thread ?? THREADS.main;
    const messages = options.messages ?? CONVERSATION;

    return [
        lunora(api.chat.composite.getThreadListData, () => threadList(options.threads)),
        lunora(api.projects.functions.listProjects, () => pageOf([]) as ReturnOf<typeof api.projects.functions.listProjects>),
        lunora(api.chat.functions.getThread, () => ownedBy(current)),
        lunora(api.chat.composite.getThreadWithData, () => {
            return {
                messages: pageOf(messages.map(ownedBy)),
                permission: options.permission ?? "admin",
                suggestions: { suggestions: options.suggestions ?? [] },
                thread: ownedBy(current),
            } as unknown as ReturnOf<typeof api.chat.composite.getThreadWithData>;
        }),
        lunora(api.chat.functions.getThreadUIMessages, () => pageOf(messages.map(ownedBy)) as ReturnOf<typeof api.chat.functions.getThreadUIMessages>),
        lunora(api.chat.sharing.resolveThreadShard, null),
        lunora(api.chat.slides.functions.getGeneratingPresentation, null),
        lunora(api.chat.functions.getFollowupSuggestions, { suggestions: options.suggestions ?? [] }),
        lunora(api.agent.threads.getThreadRelationship, null),
        lunora(api.chat.functions.getChildThreads, []),
        lunora(api.chat.functions.getThreadTemporaryStatus, null),
        lunora(api.chat.goals.functions.getThreadGoal, null),
        lunora(api.chat.group.functions.getGroupChat, null),
        lunora(api.chat.sharing.getThreadAccess, { isOwner: true, isPublic: false, permission: options.permission ?? "admin", users: [] }),
        lunora(api.chat.sharing.getThreadInvites, []),
        lunora(api.chat.streaming.getActiveStreamForThread, options.activeStream ? { streamId: STREAM_ID, ...options.activeStream } : null),
        lunora(api.chat.streaming.getStreamBody, options.streamBody ?? ({ reasoning: "", status: "pending", text: "" } as StreamBody)),
        lunora(api.chat.thread_state.markThreadViewed, { updated: true }),
        lunora(api.knowledge.functions.getThreadKnowledge, []),
        lunora(api.source_control.pr_threads.getForThread, null),
    ];
};
