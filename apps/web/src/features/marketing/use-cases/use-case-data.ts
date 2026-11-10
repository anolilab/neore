import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";

export type UseCaseSlug = "approvals" | "group-chats" | "memory" | "messaging" | "routines";

export interface UseCase {
    /** Where the person stays in control: choices, limits and the points that wait for them. */
    controls: MessageDescriptor[];
    eyebrow: MessageDescriptor;
    /** The page's `<meta name="description">`. */
    seoDescription: MessageDescriptor;
    /** The page's `<title>`. */
    seoTitle: MessageDescriptor;
    slug: UseCaseSlug;
    /** What the agent does, in order. */
    steps: MessageDescriptor[];
    summary: MessageDescriptor;
    title: MessageDescriptor;
}

export const USE_CASES: UseCase[] = [
    {
        controls: [
            msg`You choose the schedule, the run destination and the project. The project must be one you can write to.`,
            msg`A run never writes into a chat that is locked or shared by link. It starts a new chat instead, and the task says why.`,
            msg`A slot that cannot start (still running, waiting for review, blocked) is shown on the task and is not run later.`,
            msg`Rejecting a result in review marks the run as failed. The rejected answer stays on record.`,
            msg`A background run never stops to wait for you. Questions to you are dropped from it, so it finishes on its own or fails.`,
        ],
        eyebrow: msg`Routines`,
        seoDescription: msg`Routines in Neore: give the agent a task and a repeat schedule. It runs in the background, a second model checks each answer, and you get the result.`,
        seoTitle: msg`Routines — scheduled agent tasks`,
        slug: "routines",
        steps: [
            msg`Describe the task, the result you expect, and when it repeats: daily, weekly, or a cron expression in UTC.`,
            msg`Each minute the scheduler looks for due tasks and starts one run for the current slot. After an outage it starts one catch-up run, not a burst of missed runs.`,
            msg`The run goes where you chose: a new chat each time, the same chat as before, or the same chat with a fresh context.`,
            msg`A verifier model judges the answer. A pass counts as done, an unclear answer waits for your review, and an empty answer is recorded as an error.`,
            msg`You get a notification with the result, or with the reason the run failed.`,
        ],
        summary: msg`Set a task once with a repeat schedule, and the agent runs it on time in the background. A second model checks each answer before it counts as done, and you get the result as a notification.`,
        title: msg`Routines that run while you are away`,
    },
    {
        controls: [
            msg`Per tool, choose Ask, Auto or Off. Off blocks the tool, and Auto runs it without a card.`,
            msg`Always allow sets Auto for that one tool. Allow for 1 hour and Allow for today are time-boxed and lapse on their own.`,
            msg`An approved call to an external (MCP) server runs only if that tool's definition has not changed since you approved it. If it changed, the call is denied and the reason is shown.`,
            msg`An opt-in quick check can approve clearly read-only calls from servers you mark as trusted. It is off by default.`,
        ],
        eyebrow: msg`Approvals`,
        seoDescription: msg`Approvals in Neore: the agent stops before a tool that changes things or reaches outside the chat, and you decide with the exact input in front of you.`,
        seoTitle: msg`Approvals — the agent asks before a risky action`,
        slug: "approvals",
        steps: [
            msg`The model asks to use a tool you set to Ask. The run stops before the tool executes.`,
            msg`The chat shows a card with the tool name, the server it comes from, and a "Show what it will send" section with the exact input.`,
            msg`Only the owner of the chat can answer. Everyone else in a shared chat sees that the owner has to decide.`,
            msg`Approve runs the call once and the reply continues from its result. Deny sends a denial back to the model, which carries on without that tool.`,
            msg`The request is saved with the message, so the card is still there after a reload.`,
        ],
        summary: msg`Tools that change things or reach outside the chat stop and wait for your decision. You see what the tool will do before it runs, then choose to allow it once, for an hour, for the day, or always.`,
        title: msg`The agent asks before a risky action`,
    },
    {
        controls: [
            msg`Only a paired contact reaches the model. Anyone else gets a reply that the bot is private.`,
            msg`Reply tools are off by default. You switch them on per connection and choose which groups they may use.`,
            msg`Tools that need your approval are not offered in messaging apps, because nobody can approve a card there.`,
            msg`On WhatsApp a reply is sent only while the 24-hour service window from the contact's last message is open.`,
        ],
        eyebrow: msg`Messaging apps`,
        seoDescription: msg`Connect your own Telegram, WhatsApp, Slack or Discord bot to Neore and message your agent from the app you already use.`,
        seoTitle: msg`Telegram, WhatsApp, Slack and Discord — message your agent`,
        slug: "messaging",
        steps: [
            msg`Create a bot in the app and paste its token into settings. Tokens are stored encrypted, like your provider keys.`,
            msg`Each connection gets its own webhook address, and the app sends new messages to it.`,
            msg`Until a chat is paired, the bot answers only that it is private. Send /pair with the code from settings to link your contact.`,
            msg`Each message is checked for freshness and duplicates, rate limited per sender, then handed to the agent.`,
            msg`The reply goes back to the same chat. Files are fetched when the reply is made, with a 20 MB limit and a list of allowed types.`,
        ],
        summary: msg`Connect a bot you own to a messaging app and message your agent from your phone. Those messages go through the same checks as the web app and land in the same chat history.`,
        title: msg`Talk to your agent from Telegram, WhatsApp, Slack or Discord`,
    },
    {
        controls: [
            msg`Each participant runs with its own instructions, model and tools, and each speaker's usage is recorded on its own.`,
            msg`A routed or mentioned turn has at most three speakers. A parallel turn has up to four answers and a synthesis, and a debate runs up to three rounds.`,
            msg`Parallel means independent, not simultaneous: replies still come one after another, and no speaker sees the others' answers to the same message.`,
            msg`A tool that needs your approval pauses the turn with a card. Only the owner answers, and the queued speakers continue afterwards.`,
        ],
        eyebrow: msg`Group chats`,
        seoDescription: msg`Group chats in Neore: several agents with their own roles answer in one thread. Run a review panel, a debate, or a round-robin, with a cap on speakers per turn.`,
        seoTitle: msg`Group chats — several agents in one thread`,
        slug: "group-chats",
        steps: [
            msg`Create a group chat with its participants. Each one gets its own instructions, model and tools. Templates include a code review panel and a pros and cons debate.`,
            msg`Choose how turns are handed out: supervisor (a routing step picks who speaks), round-robin, mention-only, parallel, or debate.`,
            msg`For each message from you, the chat decides who answers. A routed or mentioned turn has at most three speakers.`,
            msg`Each speaker runs as a full agent reply in the same thread, and a marker shows who is talking.`,
            msg`In a debate, the pro and contra roles argue for up to three rounds, and a synthesizer role writes the outcome.`,
        ],
        summary: msg`Put several agents with their own roles in one thread. A review panel can check a change from security and performance angles, and a debate can argue both sides before a synthesis.`,
        title: msg`Several agents in one chat`,
    },
    {
        controls: [
            msg`Memory is off until you turn it on. Temporary chats and locked chats are never mined for memories.`,
            msg`Pin a memory to keep it from fading, merging or being promoted. Only activity memories fade on their own.`,
            msg`Edit or delete any memory. Clear all asks for confirmation first.`,
            msg`Each reply shows a "Memories used" list, so you can see exactly what it was given.`,
        ],
        eyebrow: msg`Memory`,
        seoDescription: msg`Memory in Neore: the agent keeps useful facts about you across chats, you can see and edit each one, and it is off until you turn it on.`,
        seoTitle: msg`Memory — what the agent keeps across chats`,
        slug: "memory",
        steps: [
            msg`After a reply, a fast check decides whether the exchange could hold a fact about you. Most turns, like a thank you, are skipped.`,
            msg`Candidate facts are saved with a type: identity, preference, context, activity or experience. Near-duplicates are merged.`,
            msg`Before each reply, the memories most relevant to the message are added to the prompt, weighted by relevance, confidence, importance and recency.`,
            msg`When a new fact conflicts with an old one, the old memory is updated, superseded, or the new fact is ignored.`,
            msg`Once a night, for users active that day, a reflection pass merges duplicates and promotes repeated facts.`,
        ],
        summary: msg`The agent keeps the facts you share and uses them in later chats, such as your preferred units or the project you are on. You can see, edit, pin or delete every memory.`,
        title: msg`Memory the agent keeps across chats`,
    },
];

export const getUseCase = (slug: string): UseCase | undefined => USE_CASES.find((useCase) => useCase.slug === slug);
