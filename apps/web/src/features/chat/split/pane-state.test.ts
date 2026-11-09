import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SendMessageEnv } from "@/features/chat/core/context/send-message";
import { runSendMessage } from "@/features/chat/core/context/send-message";
import type { PendingAttachment } from "@/features/chat/core/stores/chat-ui-store";
import { useChatUIStore } from "@/features/chat/core/stores/chat-ui-store";
import { useModelStore } from "@/features/chat/core/stores/model-store";
import { useUIStateStore } from "@/features/layout/stores/ui-state-store";

import { clearComposerDrafts, peekComposerDraft, peekParkedModelState, saveComposerDraft, setSplitViewMounted } from "./composer-drafts";
import { leaveSplitView, parkSettingsFor, restoreComposerFor, restoreLiveComposerFor, syncFocusedModel, watchPaneFocus } from "./pane-state";
import { initialSplitLayout, splitLayoutReducer } from "./split-layout";
import { survivingPaneAfterDelete, useSplitLayoutStore } from "./split-layout-store";

const fetchMock = vi.hoisted(() => vi.fn());

vi.mock("@/features/chat/core/lib/fetch-with-deadline", () => {
    return { fetchWithDeadline: fetchMock };
});
vi.mock("@/lib/env", () => {
    return { default: { VITE_LLM_GATEWAY_URL: "https://gateway.test" } };
});
vi.mock("@/lib/lunora/crpc", () => {
    return { useCRPC: vi.fn() };
});
vi.mock("@/lib/analytics", () => {
    return { trackEvent: vi.fn() };
});

const A = "thread-a";
const B = "thread-b";
const C = "thread-c";

const setPreference = (enabled: boolean): void => {
    useUIStateStore.setState((state) => {
        return { preferences: { ...state.preferences, splitViewEnabled: enabled } };
    });
};

const openPanes = (focus: string, ...ids: string[]): void => {
    let layout = initialSplitLayout();

    for (const threadId of ids) {
        layout = splitLayoutReducer(layout, { threadId, type: "open" });
    }

    layout = splitLayoutReducer(layout, { index: layout.panes.indexOf(focus), type: "focus" });
    useSplitLayoutStore.setState({ layout });
};

const focus = (threadId: string): void => {
    useSplitLayoutStore.getState().dispatch({ index: useSplitLayoutStore.getState().layout.panes.indexOf(threadId), type: "focus" });
};

const upload = (id: string, status: PendingAttachment["status"] = "uploading"): PendingAttachment => {
    return { file: new File(["x"], "x.png"), id, name: "x.png", status, type: "image" };
};

const watcher: { stop?: () => void } = {};

beforeEach(() => {
    clearComposerDrafts();
    useChatUIStore.getState().reset();
    useModelStore.setState({
        comparisonMode: false,
        currentModeThreadId: undefined,
        pendingSettings: undefined,
        selectedModel: "default-model",
        selectedModelsForComparison: [],
        selectedModelThreadId: undefined,
        threadModes: new Map(),
        userChangedMode: false,
        userChangedModel: false,
    });
    setPreference(true);
    setSplitViewMounted(true);
    openPanes(A, A, B);
    watcher.stop = watchPaneFocus();
});

afterEach(() => {
    watcher.stop?.();
    setSplitViewMounted(false);
    setPreference(false);
    useSplitLayoutStore.setState({ layout: initialSplitLayout() });
});

describe("leaving the split view (#1)", () => {
    it("parks the focused pane's draft when the view goes away, and brings it back on the next mount", () => {
        useChatUIStore.getState().setComposerText("half a thought");

        // `/chat`: the preference stays on and no pane is mounted.
        leaveSplitView(A, A);

        expect(useChatUIStore.getState().composerText).toBe("");
        expect(peekComposerDraft(A)?.composerText).toBe("half a thought");

        restoreLiveComposerFor(A);

        expect(useChatUIStore.getState().composerText).toBe("half a thought");
        expect(peekComposerDraft(A)).toBeUndefined();
    });

    it("keeps the routed chat's text in the composer when the preference was turned off", () => {
        useChatUIStore.getState().setComposerText("still here");
        setPreference(false);

        leaveSplitView(A, A);

        expect(useChatUIStore.getState().composerText).toBe("still here");
    });

    it("brings the routed chat's parked draft back when the preference was turned off with another pane focused", () => {
        saveComposerDraft(A, { composerText: "a's draft" });
        useChatUIStore.getState().setComposerText("pane b text");
        setPreference(false);

        leaveSplitView(B, A);

        expect(useChatUIStore.getState().composerText).toBe("a's draft");
        expect(peekComposerDraft(B)?.composerText).toBe("pane b text");
    });

    it("parks another pane's text even when the preference was turned off, so it does not reach the routed chat", () => {
        useChatUIStore.getState().setComposerText("pane b text");
        setPreference(false);

        leaveSplitView(B, A);

        expect(useChatUIStore.getState().composerText).toBe("");
        expect(peekComposerDraft(B)?.composerText).toBe("pane b text");
    });
});

describe("a failed send (#3, #4, #10)", () => {
    const sendFromA = async (failure: () => void): Promise<void> => {
        fetchMock.mockImplementation(async () => {
            failure();
            throw new Error("network down");
        });
        useChatUIStore.getState().setComposerText("prompt for a");
        useModelStore.setState({ pendingSettings: { language: "de" }, selectedModelThreadId: A });

        const env = {
            authGate: { isReady: () => true, wait: async () => true },
            authHeader: () => {
                return {};
            },
            crpc: {},
            defaultLanguage: "en",
            getChangedSettings: () => {
                const pending = useModelStore.getState().pendingSettings;

                useModelStore.getState().setPendingSettings(undefined);

                return pending ?? null;
            },
            getPendingSettingsFromStore: () => null,
            handleError: vi.fn(),
            isMountedRef: { current: true },
            kickOffMedia: vi.fn(),
            localTarget: null,
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
            texts: { bannedContent: () => "", localTextOnly: () => "", sessionNotReady: () => "" },
            threadDataRef: { current: undefined },
            threadId: A,
            turnRef: { current: 1 },
        } as unknown as SendMessageEnv;

        await runSendMessage(env, "prompt for a");
    };

    it("hands the prompt and the settings back to the chat that sent them when another pane has focus by then", async () => {
        await sendFromA(() => focus(B));

        // Pane B has the live composer and store; A's text and settings wait in A's parked state.
        expect(useChatUIStore.getState().composerText).toBe("");
        expect(peekComposerDraft(A)?.composerText).toBe("prompt for a");
        expect(useModelStore.getState().pendingSettings).toBeUndefined();
        expect(peekParkedModelState(A)?.pendingSettings).toEqual({ language: "de" });

        // Focus returns: both come back live.
        focus(A);
        restoreLiveComposerFor(A);
        syncFocusedModel({ isLoaded: true, mode: "text", model: "m", threadId: A });

        expect(useChatUIStore.getState().composerText).toBe("prompt for a");
        expect(useModelStore.getState().pendingSettings).toEqual({ language: "de" });
    });

    it("restores into the live composer when the sender still has focus", async () => {
        await sendFromA(() => undefined);

        expect(useChatUIStore.getState().composerText).toBe("prompt for a");
        expect(peekComposerDraft(A)).toBeUndefined();
    });

    it("parks a failed send's text on /chat instead of writing it into the new-chat composer", async () => {
        setSplitViewMounted(false);

        await sendFromA(() => undefined);

        expect(useChatUIStore.getState().composerText).toBe("");
        expect(peekComposerDraft(A)?.composerText).toBe("prompt for a");
    });

    it("does not overwrite a draft the owner started meanwhile, whichever pane is focused (#4)", () => {
        focus(B);
        useChatUIStore.getState().setComposerText("pane b typing");
        saveComposerDraft(A, { composerText: "newer a draft" });

        restoreComposerFor(A, { attachedReferences: [], composerAttachments: [], composerText: "old prompt" });

        expect(peekComposerDraft(A)?.composerText).toBe("newer a draft");
        expect(useChatUIStore.getState().composerText).toBe("pane b typing");
    });

    it("is not blocked by the focused pane's draft when the owner has none (#4)", () => {
        focus(B);
        useChatUIStore.getState().setComposerText("pane b typing");

        restoreComposerFor(A, { attachedReferences: [], composerAttachments: [], composerText: "old prompt" });

        expect(peekComposerDraft(A)?.composerText).toBe("old prompt");
        expect(useChatUIStore.getState().composerText).toBe("pane b typing");
    });

    it("keeps a pick made in the parked chat since the send ahead of the consumed settings (#10)", () => {
        focus(B);
        parkSettingsFor(A, { language: "de", statelessMode: true });
        parkSettingsFor(A, { language: "fr" });

        expect(peekParkedModelState(A)?.pendingSettings).toEqual({ language: "de", statelessMode: true });
    });
});

describe("an upload that finishes after the pane lost focus (#7)", () => {
    it("updates the attachment in the parked draft", () => {
        const id = useChatUIStore.getState().addAttachment(new File(["x"], "x.png"));

        useChatUIStore.getState().updateAttachment(id, { status: "uploading" });
        focus(B);

        expect(useChatUIStore.getState().composerAttachments).toHaveLength(0);

        useChatUIStore.getState().updateAttachment(id, { fileId: "file-1", status: "complete" });

        expect(peekComposerDraft(A)?.composerAttachments[0]).toMatchObject({ fileId: "file-1", id, status: "complete" });

        focus(A);
        restoreLiveComposerFor(A);

        expect(useChatUIStore.getState().composerAttachments[0]?.status).toBe("complete");
    });

    it("ignores an id that nothing holds", () => {
        saveComposerDraft(A, { composerAttachments: [upload("other")] });

        useChatUIStore.getState().updateAttachment("gone", { status: "complete" });

        expect(peekComposerDraft(A)?.composerAttachments[0]?.status).toBe("uploading");
    });
});

describe("model choices across a pane switch (#9)", () => {
    it("keeps the model picked in pane A while pane B loads and has focus", () => {
        syncFocusedModel({ isLoaded: true, mode: "text", model: "model-a", threadId: A });
        useModelStore.getState().setSelectedModel("picked-in-a", A);
        useModelStore.getState().setPendingSettings({ customSystemPrompt: "be brief" });

        focus(B);
        syncFocusedModel({ isLoaded: true, mode: "text", model: "model-b", threadId: B });

        expect(useModelStore.getState().selectedModel).toBe("model-b");
        expect(useModelStore.getState().pendingSettings).toBeUndefined();

        focus(A);
        syncFocusedModel({ isLoaded: true, mode: "text", model: "model-a", threadId: A });

        expect(useModelStore.getState().selectedModel).toBe("picked-in-a");
        expect(useModelStore.getState().userChangedModel).toBe(true);
        expect(useModelStore.getState().pendingSettings).toEqual({ customSystemPrompt: "be brief" });
    });
});

describe("comparison mode (#11)", () => {
    it("leaves the outgoing comparison parent's mode off when focus moves to a chat with a parked pick", () => {
        focus(A);
        syncFocusedModel({ isLoaded: true, mode: "text", model: "model-a", threadId: A });
        useModelStore.getState().setSelectedModel("picked-in-a", A);

        focus(B);
        syncFocusedModel({ isLoaded: true, mode: "text", model: "model-b", threadId: B });
        useModelStore.getState().setComparisonMode(true);
        useModelStore.getState().setSelectedModelsForComparison(["m1", "m2"]);

        // A's parked pick makes the load skip, so nothing else would turn B's comparison off.
        focus(A);
        syncFocusedModel({ isLoaded: true, mode: "text", model: "model-a", threadId: A });

        expect(useModelStore.getState().comparisonMode).toBe(false);
        expect(useModelStore.getState().selectedModelsForComparison).toEqual([]);
    });
});

describe("a document whose pane closes (#12)", () => {
    it("moves to the focused pane, so the panel shows it and its close control is reachable there", () => {
        useChatUIStore.getState().openCanvas("doc-1", A);

        useSplitLayoutStore.getState().dispatch({ index: 0, type: "close" });

        expect(useChatUIStore.getState()).toMatchObject({ activeDocumentId: "doc-1", canvasThreadId: B, isCanvasOpen: true });
    });
});

const readsEvery = async (): Promise<unknown> => {
    return {};
};

describe("deleting the routed chat with other panes open (#14)", () => {
    it("picks the first open pane that survives, for the single and the bulk delete alike", async () => {
        openPanes(A, A, B, C);

        await expect(survivingPaneAfterDelete([A], readsEvery)).resolves.toBe(B);
        await expect(survivingPaneAfterDelete([A, B], readsEvery)).resolves.toBe(C);
    });

    it("has no survivor when every pane is deleted or the preference is off", async () => {
        await expect(survivingPaneAfterDelete([A, B], readsEvery)).resolves.toBeUndefined();

        setPreference(false);

        await expect(survivingPaneAfterDelete([A], readsEvery)).resolves.toBeUndefined();
    });
});
