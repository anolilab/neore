import type { ReturnOf } from "@lunora/react";
import { api } from "@neore/backend/api";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, screen, userEvent } from "storybook/test";

import { useChatUIStore } from "@/features/chat/core/stores/chat-ui-store";
import usePresentationViewerStore from "@/features/slides/hooks/use-presentation-viewer-store";
import { Route as ThreadRoute } from "@/routes/(chat)/chat/$threadId";
import { Route as ChatLayoutRoute } from "@/routes/(chat)/route";
import { ago, DAY, HOUR, MINUTE } from "@/storybook/clock";
import type { ChatMessage } from "@/storybook/fixtures/chat";
import { assistantMessage, chatFixtures, THREAD_IDS, userMessage } from "@/storybook/fixtures/chat";
import { gatewayModelsHandler } from "@/storybook/fixtures/models";
import { OWNER } from "@/storybook/fixtures/owner";
import { shellFixtures } from "@/storybook/fixtures/shell";
import { userFixtures } from "@/storybook/fixtures/user";
import { lunora, lunoraHandlers } from "@/storybook/lunora";
import { StoryPage } from "@/storybook/page";

const PAGE_WAIT = { timeout: 8000 } as const;

type Part = ChatMessage["parts"][number];

/** A reply whose parts are the given ones, after an opening line of text. */
const reply = (text: string, order: number, parts: unknown[]): ChatMessage => {
    const base = assistantMessage(text, order);

    return { ...base, parts: [...base.parts, ...(parts as Part[])] } as ChatMessage;
};

const DOCUMENT_ID = "0193c1b2-7d1e-7a3c-9f00-0000000000d1";
const PRESENTATION_ID = "0193c1b2-7d1e-7a3c-9f00-0000000000e1";

const CODE = [
    "export const tracks = [",
    '    { name: "onboarding", owner: "Ada", due: "2026-12-11" },',
    '    { name: "billing", owner: "Sam", due: "2026-12-18" },',
    '    { name: "docs", owner: "Grace", due: "2026-12-18" },',
    "] as const;",
    "",
    "export const overdue = (today: Date) => tracks.filter((track) => new Date(track.due) < today);",
].join("\n");

const TEXT = [
    "# Launch checklist",
    "",
    "- Freeze the feature list",
    "- Write the rollout plan",
    "- Bug bash with the whole team",
    "",
    "Owners are named in the plan.",
].join("\n");

const documentFixture = (kind: "code" | "text") =>
    lunora(api.agent.documents.getDocument, {
        _creationTime: ago(DAY),
        _id: DOCUMENT_ID,
        canEdit: true,
        content: kind === "code" ? CODE : TEXT,
        kind,
        language: kind === "code" ? "typescript" : undefined,
        ownsThread: true,
        status: "idle",
        threadId: THREAD_IDS.main,
        title: kind === "code" ? "launch-tracks.ts" : "Launch checklist",
        userId: OWNER,
        version: 2,
    } as unknown as ReturnOf<typeof api.agent.documents.getDocument>);

const documentCard = (kind: "code" | "text", order: number): ChatMessage =>
    reply("I put the plan in a document you can edit.", order, [
        {
            output: { documentId: DOCUMENT_ID, kind, threadId: THREAD_IDS.main, title: kind === "code" ? "launch-tracks.ts" : "Launch checklist", version: 2 },
            state: "output-available",
            toolCallId: `call_doc_${kind}`,
            type: "tool-createDocument",
        },
    ]);

const meta = {
    args: {
        levels: [
            { id: "/(chat)", route: ChatLayoutRoute },
            { path: "chat/$threadId", route: ThreadRoute },
        ],
        url: `/chat/${THREAD_IDS.main}`,
    },
    component: StoryPage,
    parameters: {
        layout: "fullscreen",
        msw: { handlers: { gateway: gatewayModelsHandler(), lunora: lunoraHandlers(...userFixtures(), ...shellFixtures(), ...chatFixtures()) } },
    },
    title: "Pages/Chat parts",
} satisfies Meta<typeof StoryPage>;

export default meta;

type Story = StoryObj<typeof meta>;

const withMessages = (messages: ChatMessage[], ...extra: ReturnType<typeof lunora>[]) => {
    return {
        msw: {
            handlers: {
                gateway: gatewayModelsHandler(),
                lunora: lunoraHandlers(
                    ...userFixtures(),
                    ...shellFixtures(),
                    ...chatFixtures({ messages }),
                    lunora(api.chat.goals.functions.getPinnedGoal, null),
                    ...extra,
                ),
            },
        },
    };
};

/** A tool call that waits for the owner: the request, what it will send, and the answers. */
export const ToolApproval: Story = {
    parameters: withMessages([
        userMessage("Check the docs for the billing webhook and summarise the retry rules.", 0),
        reply("I need to read the docs site for that.", 0, [
            {
                approval: { id: "approval_1" },
                input: { query: "billing webhook retry policy", site: "docs.example.com" },
                state: "approval-requested",
                toolCallId: "call_approval_1",
                type: "tool-searchDocs",
            },
        ]),
    ]),
    play: async ({ canvas }) => {
        await expect(await canvas.findByRole("button", { name: "Approve searchDocs once" }, PAGE_WAIT)).toBeInTheDocument();
    },
};

/** Finished tool calls: one the quick check let run, one that read a page, one that failed. */
export const ToolCalls: Story = {
    play: async ({ canvas }) => {
        await expect(await canvas.findByText("fetchPage", undefined, PAGE_WAIT)).toBeInTheDocument();
        await expect(await canvas.findByText("Approved automatically", { exact: false }, PAGE_WAIT)).toBeInTheDocument();
    },
    parameters: withMessages([
        userMessage("Look up the retry rules and the rate limits.", 0),
        reply("Here is what I found.", 0, [
            {
                callProviderMetadata: { neore: { autoApproval: { by: "quick-check", reason: "It only reads a public docs page." } } },
                input: { query: "billing webhook retry policy" },
                output: { results: [{ title: "Webhook retries", url: "https://docs.example.com/webhooks" }] },
                state: "output-available",
                toolCallId: "call_ok",
                type: "tool-searchDocs",
            },
            {
                errorText: "Request timed out after 10 s",
                input: { url: "https://status.example.com" },
                state: "output-error",
                toolCallId: "call_err",
                type: "tool-fetchPage",
            },
            { state: "input-available", input: { query: "rate limits" }, toolCallId: "call_run", type: "tool-searchDocs" },
        ]),
    ]),
};

/** The canvas side panel with a code document, next to the thread that made it. */
export const CanvasCode: Story = {
    play: async ({ canvas }) => {
        await expect(await canvas.findByRole("region", { name: "Canvas" }, PAGE_WAIT)).toBeInTheDocument();
    },
    beforeEach: () => {
        useChatUIStore.getState().openCanvas(DOCUMENT_ID, THREAD_IDS.main);

        return () => useChatUIStore.getState().closeCanvas();
    },
    parameters: withMessages([userMessage("Write the tracks as code.", 0), documentCard("code", 0)], documentFixture("code")),
};

/** The canvas with a text document. */
export const CanvasText: Story = {
    play: async ({ canvas }) => {
        await expect(await canvas.findByRole("region", { name: "Canvas" }, PAGE_WAIT)).toBeInTheDocument();
    },
    beforeEach: () => {
        useChatUIStore.getState().openCanvas(DOCUMENT_ID, THREAD_IDS.main);

        return () => useChatUIStore.getState().closeCanvas();
    },
    parameters: withMessages([userMessage("Write the launch checklist.", 0), documentCard("text", 0)], documentFixture("text")),
};

const slide = (slideNumber: number, title: string, body: string) => {
    return {
        _creationTime: ago(HOUR),
        _id: `slide_${String(slideNumber)}`,
        createdAt: ago(HOUR),
        htmlContent: `<div style="display:flex;flex-direction:column;justify-content:center;height:100%;padding:120px;background:#f5f5f0;color:#18181b"><h1 style="font-size:96px;margin:0 0 32px">${title}</h1><p style="font-size:44px;margin:0;color:#52525b">${body}</p></div>`,
        presentationId: PRESENTATION_ID,
        slideNumber,
        title,
        updatedAt: ago(HOUR),
    };
};

/** The full-screen slide viewer over the chat. */
export const Slides: Story = {
    play: async () => {
        await expect(await screen.findByRole("dialog", { name: "Q1 launch" }, PAGE_WAIT)).toBeInTheDocument();
    },
    beforeEach: () => {
        usePresentationViewerStore.getState().openPresentation(PRESENTATION_ID, 1);

        return () => usePresentationViewerStore.getState().closePresentation();
    },
    parameters: withMessages(
        [
            userMessage("Make a three-slide deck for the launch.", 0),
            reply("The deck is ready.", 0, [
                {
                    output: { presentationId: PRESENTATION_ID, slideCount: 3, styleName: "Paper", title: "Q1 launch" },
                    state: "output-available",
                    toolCallId: "call_deck",
                    type: "tool-createPresentation",
                },
            ]),
        ],
        lunora(api.chat.slides.functions.getPresentation, {
            _creationTime: ago(HOUR),
            _id: PRESENTATION_ID,
            createdAt: ago(HOUR),
            name: "q1-launch",
            status: "complete",
            styleName: "Paper",
            threadId: THREAD_IDS.main,
            title: "Q1 launch",
            totalSlides: 3,
            updatedAt: ago(HOUR),
            userId: OWNER,
        } as unknown as ReturnOf<typeof api.chat.slides.functions.getPresentation>),
        lunora(api.chat.slides.functions.getPresentationSlides, [
            slide(1, "Q1 launch", "Six weeks, three engineers"),
            slide(2, "Scope", "Freeze the list in week two"),
            slide(3, "Rollout", "A staged release from week five"),
        ] as unknown as ReturnOf<typeof api.chat.slides.functions.getPresentationSlides>),
    ),
};

const INBOX = [
    {
        _id: "n1",
        body: "Deploy the preview to staging?",
        createdAt: ago(10 * MINUTE),
        link: "/chat/t1",
        read: false,
        title: "Deploy the preview",
        type: "tool_approval",
    },
    { _id: "n2", createdAt: ago(HOUR), outcome: "success", read: false, title: "Weekly report", type: "task" },
    { _id: "n3", createdAt: ago(5 * HOUR), outcome: "failure", read: true, title: "Nightly eval", type: "eval" },
    { _id: "n4", body: "Your export is ready to download.", createdAt: ago(DAY), read: true, title: "Data export", type: "data_export" },
] as const;

/** The notifications popover opened from the sidebar rail. */
export const NotificationsOpen: Story = {
    parameters: withMessages(
        [userMessage("Hello", 0), assistantMessage("Hi, how can I help?", 0)],
        lunora(api.notifications.functions.getNotificationInbox, {
            items: INBOX,
            unreadCount: 2,
        } as unknown as ReturnOf<typeof api.notifications.functions.getNotificationInbox>),
    ),
    play: async ({ canvas }) => {
        await userEvent.click(await canvas.findByRole("button", { name: /Notifications, 2 unread/ }, PAGE_WAIT));
        await expect(await screen.findByText("Mark all read", undefined, PAGE_WAIT)).toBeInTheDocument();
    },
};

/** The model picker opened from the composer. */
export const ModelPickerOpen: Story = {
    play: async ({ canvas }) => {
        const [button] = await canvas.findAllByRole("button", { name: "Model: Claude Sonnet 4.5" }, PAGE_WAIT);

        await userEvent.click(button as HTMLElement);
        await userEvent.click(await screen.findByRole("button", { name: "All models" }, PAGE_WAIT));
        // The name is also on the composer's model button: wait for the picker's own option.
        await expect(await screen.findByRole("option", { name: /Claude Sonnet 4\.5/ }, PAGE_WAIT)).toBeInTheDocument();
    },
};
