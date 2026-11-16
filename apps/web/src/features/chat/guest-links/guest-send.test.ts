/**
 * The owner's Send of a held guest note goes through the ordinary send, carrying the note's id that the Guests tab passes;
 * no other send carries one, and a local turn (saved as the owner's own words) refuses it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { holdSendForSignIn, runSendMessage } from "@/features/chat/core/context/send-message";
import { holdForSignIn } from "@/features/chat/core/hooks/use-pending-send";
import { useChatUIStore } from "@/features/chat/core/stores/chat-ui-store";
import { clearSendStarting, isSendStarting, markSendStarting, subscribeSendStarting } from "@/features/chat/core/utils/send-in-flight";
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
    useChatUIStore.setState({ composerBannedContent: null, isSubmitting: false });
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

        const outcome = await runSendMessage(timedOut as never, NOTE.text, undefined, FROM_PANEL);

        expect(sentBodies).toHaveLength(0);
        expect(useChatUIStore.getState().composerText).toBe("my half-written reply");
        expect(outcome).toStrictEqual({ failure: "guest note not sent", refused: false, started: false });
        expect(timedOut.handleError).not.toHaveBeenCalled();
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
    ] as const)("says what a %s refusal of the note means, in the app's words, to the Guests tab only", async (answer, message) => {
        const refused = env();

        gateway.answer = answer;

        const outcome = await runSendMessage(refused as never, NOTE.text, undefined, FROM_PANEL);

        expect(outcome).toStrictEqual({ failure: message, refused: false, started: false });
        // Not the chat's error banner, whose Retry would rerun the owner's last reply.
        expect(refused.handleError).not.toHaveBeenCalled();
    });

    it("leaves the owner's error banner, and its Retry, in place: only the owner's own send clears it", async () => {
        const guest = env();
        const own = env();

        gateway.answer = "accept";
        await runSendMessage(guest as never, NOTE.text, undefined, FROM_PANEL);
        await runSendMessage(own as never, "my own words");

        expect(guest.setError).not.toHaveBeenCalledWith(null);
        expect(own.setError).toHaveBeenCalledWith(null);
    });

    it("counts the note's send as started only once the gateway took it", async () => {
        gateway.answer = "accept";

        expect(await runSendMessage(env() as never, NOTE.text, undefined, FROM_PANEL)).toStrictEqual({ refused: false, started: true });
    });

    it("does not read another 409, a host-run thread's, as the note already sent", async () => {
        const hostRun = env();

        gateway.answer = "hostRun";

        const outcome = await runSendMessage(hostRun as never, NOTE.text, undefined, FROM_PANEL);

        expect(outcome).toMatchObject({ failure: "This thread runs on a paired computer.", started: false });
        expect(hostRun.handleError).not.toHaveBeenCalled();
    });

    it("counts the send as starting in its thread until it returns, so no other send starts beside it", async () => {
        gateway.answer = "accept";

        const sending = runSendMessage(env() as never, NOTE.text, undefined, FROM_PANEL);

        expect(isSendStarting("t1")).toBe(true);
        await sending;
        expect(isSendStarting("t1")).toBe(false);
    });

    it("ends a send refused for banned words as refused, so what queued behind it waits", async () => {
        const ended = vi.fn();
        const unsubscribe = subscribeSendStarting(ended);

        try {
            gateway.answer = "banned";
            await runSendMessage(env() as never, "my own words");
            gateway.answer = "unavailable";
            await runSendMessage(env() as never, "my own words");
        } finally {
            unsubscribe();
        }

        expect(ended.mock.calls).toStrictEqual([[{ refused: true, threadId: "t1" }], [{ refused: false, threadId: "t1" }]]);
    });

    it("tells a refusal at once, though another send in the thread is still starting", () => {
        const ended = vi.fn();
        const unsubscribe = subscribeSendStarting(ended);

        try {
            markSendStarting("t1");
            markSendStarting("t1");
            clearSendStarting("t1", { refused: true });

            expect(ended.mock.calls).toStrictEqual([[{ refused: true, threadId: "t1" }]]);

            clearSendStarting("t1");

            expect(ended).toHaveBeenLastCalledWith({ refused: false, threadId: "t1" });
        } finally {
            unsubscribe();
        }
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

        const outcome = await runSendMessage(banned as never, NOTE.text, undefined, FROM_PANEL);

        expect(useChatUIStore.getState().composerBannedContent).toBeNull();
        expect(useChatUIStore.getState().composerText).toBe("my half-written reply");
        expect(outcome).toMatchObject({ started: false });
        expect(outcome.failure).not.toBe("");
        expect(banned.handleError).not.toHaveBeenCalled();
    });

    it("runs on the thread's saved settings, leaving the owner's unsent ones for the owner's next send", async () => {
        let unsent: { customSystemPrompt: string } | null = { customSystemPrompt: "the owner's new prompt" };
        // As the store does: the changes are taken out when read.
        const getChangedSettings = vi.fn(() => {
            const taken = unsent;

            unsent = null;

            return taken;
        });

        gateway.answer = "accept";
        await runSendMessage(env({ getChangedSettings }) as never, NOTE.text, undefined, FROM_PANEL);

        expect(getChangedSettings).not.toHaveBeenCalled();
        expect(sentBodies[0]).not.toHaveProperty("customSystemPrompt");

        await runSendMessage(env({ getChangedSettings }) as never, "my own words");

        expect(sentBodies[1]).toMatchObject({ customSystemPrompt: "the owner's new prompt" });
    });

    it("leaves the composer's submit guard to the composer that set it, on every way a guest's send ends", async () => {
        const timedOut = env({ authGate: { isReady: () => false, set: vi.fn(), wait: vi.fn(async () => false) } });

        // Another pane's send is waiting for its session.
        useChatUIStore.getState().setIsSubmitting(true);
        gateway.answer = "accept";
        await runSendMessage(env() as never, NOTE.text, undefined, FROM_PANEL);
        await runSendMessage(timedOut as never, NOTE.text, undefined, FROM_PANEL);
        await runSendMessage(env() as never, "\u{200B}", undefined, FROM_PANEL);
        holdSendForSignIn(NOTE.text, FROM_PANEL);

        expect(useChatUIStore.getState().isSubmitting).toBe(true);

        await runSendMessage(env() as never, "my own words");

        expect(useChatUIStore.getState().isSubmitting).toBe(false);
    });

    it("refuses a local turn, which would save the guest's words as the owner's", async () => {
        const local = env({ localTarget: { endpoint: "local" } });

        useChatUIStore.getState().setComposerText("my half-written reply");

        const outcome = await runSendMessage(local as never, NOTE.text, undefined, FROM_PANEL);

        expect(local.sendLocalTurn).not.toHaveBeenCalled();
        expect(outcome).toStrictEqual({ failure: "hosted only", refused: false, started: false });
        expect(local.handleError).not.toHaveBeenCalled();
        expect(useChatUIStore.getState().composerText).toBe("my half-written reply");
    });
});
