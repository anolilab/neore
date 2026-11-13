/**
 * The owner's Send of a held guest note goes through the ordinary send, carrying the note's id that the Guests tab passes;
 * no other send carries one, and a local turn (saved as the owner's own words) refuses it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { holdSendForSignIn, runSendMessage } from "@/features/chat/core/context/send-message";
import { holdForSignIn } from "@/features/chat/core/hooks/use-pending-send";
import { useChatUIStore } from "@/features/chat/core/stores/chat-ui-store";
import { isSendStarting } from "@/features/chat/core/utils/send-in-flight";
import { useGoalComposer } from "@/features/chat/goal/goal-store";

vi.mock("@/lib/env", () => {
    return { default: { VITE_LLM_GATEWAY_URL: "https://gateway.test" } };
});
vi.mock("@/lib/analytics", () => {
    return { trackEvent: vi.fn() };
});
vi.mock("@/features/chat/core/hooks/use-pending-send", () => {
    return { holdForSignIn: vi.fn() };
});
vi.mock("@/features/auth/stores/login-prompt-store", () => {
    return { openLoginPrompt: vi.fn() };
});
vi.mock("@neore/client-runtime", async (importOriginal) => {
    return { ...(await importOriginal<typeof import("@neore/client-runtime")>()), withUnlockProofBody: (body: unknown) => body };
});

const sentBodies: Record<string, unknown>[] = [];
/** How `/chat/start` answers: a failure that may pass, a refusal of the note itself, banned words, or a send it took. */
const gateway: {
    answer: "accept" | "asGoal" | "banned" | "beingSent" | "conflict" | "hostRun" | "linkEnded" | "notSendable" | "textModel" | "unavailable";
} = { answer: "unavailable" };

const ANSWERS = {
    accept: () => Response.json({ gatewayUrl: "https://gateway.test", messageId: "m1", threadId: "t1" }),
    banned: () => Response.json({ bannedWords: ["call"], error: "BANNED_CONTENT" }, { status: 400 }),
    conflict: () => Response.json({ error: "GUEST_NOTE_ALREADY_SENT", message: "That guest note was already sent." }, { status: 409 }),
    hostRun: () => Response.json({ error: "HOST_RUN_THREAD", message: "This thread runs on a paired computer." }, { status: 409 }),
    asGoal: () => Response.json({ error: "GUEST_NOTE_AS_GOAL", message: "A guest note cannot be a goal." }, { status: 400 }),
    beingSent: () => Response.json({ error: "GUEST_NOTE_BEING_SENT", message: "That guest note is being sent." }, { status: 409 }),
    linkEnded: () => Response.json({ error: "GUEST_LINK_ENDED", message: "That guest link has ended." }, { status: 400 }),
    notSendable: () => Response.json({ error: "GUEST_NOTE_NOT_SENDABLE", message: "That guest note cannot be sent in this chat." }, { status: 400 }),
    textModel: () => Response.json({ error: "GUEST_NOTE_NEEDS_TEXT_MODEL", message: "Switch to a text model." }, { status: 400 }),
    unavailable: () => Response.json({ error: "unavailable" }, { status: 503 }),
};

const NOTE = { messageId: "note-1", text: "please call me back", threadId: "t1" };
/** What the Guests tab's Send passes with the note's text; no other caller passes anything. */
const FROM_PANEL = { guestMessageId: NOTE.messageId };

const env = (overrides: Record<string, unknown> = {}) => {
    return {
        authGate: { isReady: () => true, set: vi.fn(), wait: vi.fn() },
        authHeader: () => {
            return {};
        },
        crpc: {},
        defaultLanguage: "en",
        getChangedSettings: () => null,
        getPendingSettingsFromStore: () => null,
        handleError: vi.fn(),
        isMountedRef: { current: true },
        kickOffMedia: vi.fn(),
        localTarget: undefined,
        messagesRef: { current: [] },
        model: "m",
        navigate: vi.fn(),
        newChatsTemporary: false,
        queryClient: {},
        refetchSession: vi.fn(),
        sendLocalTurn: vi.fn(),
        setError: vi.fn(),
        setGatewayInfo: vi.fn(),
        setIsRegenerating: vi.fn(),
        setOptimisticMessages: vi.fn(),
        setTransitioningMessage: vi.fn(),
        startTurn: () => 1,
        streamingMessageRef: { current: null },
        texts: {
            bannedContent: () => "",
            guestLinkEnded: () => "link ended",
            guestNoteAlreadySent: () => "already sent",
            guestNoteAsGoal: () => "not as a goal",
            guestNoteBeingSent: () => "being sent",
            guestNoteNeedsTextModel: () => "pick a text model",
            guestNoteNotLocal: () => "hosted only",
            guestNoteNotSendable: () => "not in this chat",
            guestNoteSessionNotReady: () => "guest note not sent",
            localTextOnly: () => "",
            sessionNotReady: () => "",
        },
        threadDataRef: { current: undefined },
        threadId: "t1",
        turnRef: { current: 1 },
        ...overrides,
    };
};

beforeEach(() => {
    sentBodies.length = 0;
    gateway.answer = "unavailable";
    vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: unknown, init?: RequestInit) => {
            sentBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);

            return ANSWERS[gateway.answer]();
        }),
    );
});

afterEach(() => {
    vi.unstubAllGlobals();
    useGoalComposer.getState().setEnabled(false);
    useChatUIStore.getState().setComposerText("");
    useChatUIStore.setState({ composerBannedContent: null });
    vi.mocked(holdForSignIn).mockClear();
});

describe("runSendMessage with a held guest note", () => {
    it("carries the note's id on every send from the Guests tab, a retry after a failure included", async () => {
        await runSendMessage(env() as never, NOTE.text, undefined, FROM_PANEL);
        await runSendMessage(env() as never, NOTE.text, undefined, FROM_PANEL);

        expect(sentBodies.map((body) => body.guestMessageId)).toStrictEqual(["note-1", "note-1"]);
    });

    it("never carries a guest's id on a composer or queued send, even of the note's own words right after its send failed", async () => {
        await runSendMessage(env() as never, NOTE.text, undefined, FROM_PANEL);
        await runSendMessage(env() as never, NOTE.text);
        await runSendMessage(env() as never, NOTE.text, [{ fileId: "owner-file", status: "complete" }] as never);

        expect(sentBodies.map((body) => body.guestMessageId)).toStrictEqual(["note-1", undefined, undefined]);
        expect(sentBodies[2]?.fileIds).toStrictEqual(["owner-file"]);
    });

    it("sends the note without a goal and without touching the owner's draft", async () => {
        gateway.answer = "accept";
        useGoalComposer.getState().setEnabled(true);
        useChatUIStore.getState().setComposerText("my half-written reply");

        await runSendMessage(env() as never, NOTE.text, undefined, FROM_PANEL);

        expect(sentBodies[0]).toMatchObject({ guestMessageId: "note-1" });
        expect(sentBodies[0]).not.toHaveProperty("goal");
        expect(useChatUIStore.getState().composerText).toBe("my half-written reply");
        // The owner's armed goal waits for their own next message.
        expect(useGoalComposer.getState().enabled).toBe(true);
    });

    it("leaves the owner's draft alone when the session never comes", async () => {
        const timedOut = env({ authGate: { isReady: () => false, set: vi.fn(), wait: vi.fn(async () => false) } });

        useChatUIStore.getState().setComposerText("my half-written reply");

        await runSendMessage(timedOut as never, NOTE.text, undefined, FROM_PANEL);

        expect(sentBodies).toHaveLength(0);
        expect(useChatUIStore.getState().composerText).toBe("my half-written reply");
        expect(timedOut.handleError).toHaveBeenCalledWith(expect.objectContaining({ message: "guest note not sent" }));
    });

    it("neither puts the note in the composer nor holds it as the owner's words when they must sign in first", () => {
        useChatUIStore.getState().setComposerText("my half-written reply");

        holdSendForSignIn(NOTE.text, FROM_PANEL);

        expect(useChatUIStore.getState().composerText).toBe("my half-written reply");
        expect(holdForSignIn).not.toHaveBeenCalled();

        holdSendForSignIn("my own words");

        expect(useChatUIStore.getState().composerText).toBe("my own words");
        expect(holdForSignIn).toHaveBeenCalledWith("my own words");
    });

    it.each([
        ["textModel", "pick a text model"],
        ["conflict", "already sent"],
        ["notSendable", "not in this chat"],
        ["asGoal", "not as a goal"],
        ["beingSent", "being sent"],
        ["linkEnded", "link ended"],
    ] as const)("says what a %s refusal of the note means, in the app's words", async (answer, message) => {
        const refused = env();

        gateway.answer = answer;

        await runSendMessage(refused as never, NOTE.text, undefined, FROM_PANEL);

        expect(refused.handleError).toHaveBeenCalledWith(expect.objectContaining({ message }));
    });

    it("does not read another 409, a host-run thread's, as the note already sent", async () => {
        const hostRun = env();

        gateway.answer = "hostRun";

        await runSendMessage(hostRun as never, NOTE.text, undefined, FROM_PANEL);

        expect(hostRun.handleError).toHaveBeenCalledWith(expect.objectContaining({ message: "This thread runs on a paired computer." }));
    });

    it("counts the send as starting in its thread until it returns, so no other send starts beside it", async () => {
        gateway.answer = "accept";

        const sending = runSendMessage(env() as never, NOTE.text, undefined, FROM_PANEL);

        expect(isSendStarting("t1")).toBe(true);
        await sending;
        expect(isSendStarting("t1")).toBe(false);
    });

    it("sends none of the composer's files with a guest's note", async () => {
        await runSendMessage(env() as never, NOTE.text, [{ fileId: "owner-file", status: "complete" }] as never, FROM_PANEL);

        expect(sentBodies[0]).toMatchObject({ guestMessageId: "note-1" });
        expect(sentBodies[0]?.fileIds).toBeUndefined();
    });

    it("shows banned words in a guest's note as an error, not as the owner's composer banner", async () => {
        const banned = env();

        gateway.answer = "banned";
        useChatUIStore.getState().setComposerText("my half-written reply");

        await runSendMessage(banned as never, NOTE.text, undefined, FROM_PANEL);

        expect(useChatUIStore.getState().composerBannedContent).toBeNull();
        expect(useChatUIStore.getState().composerText).toBe("my half-written reply");
        expect(banned.handleError).toHaveBeenCalled();
    });

    it("refuses a local turn, which would save the guest's words as the owner's", async () => {
        const local = env({ localTarget: { endpoint: "local" } });

        useChatUIStore.getState().setComposerText("my half-written reply");

        await runSendMessage(local as never, NOTE.text, undefined, FROM_PANEL);

        expect(local.sendLocalTurn).not.toHaveBeenCalled();
        expect(useChatUIStore.getState().composerText).toBe("my half-written reply");
    });
});
