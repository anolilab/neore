// @vitest-environment jsdom
// eslint-disable-next-line testing-library/no-manual-cleanup -- vitest runs without globals here, so Testing Library registers no cleanup of its own
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChatComposer } from "./chat-composer";
import type { DraftStore } from "./draft-store";
import { createDraftStore } from "./draft-store";

// The native primitives as plain DOM elements: what is measured here is which components render, not how they look.
// eslint-disable-next-line no-restricted-syntax -- react-native's primitives cannot load in Node; there is nothing to inject
vi.mock(import("react-native"), () => ({
    Pressable: ({ children, disabled, onPress }: { children: ReactNode; disabled?: boolean; onPress?: () => void }) => (
            <button disabled={disabled} onClick={onPress} type="button">
                {children}
            </button>
    ),
    Text: ({ children }: { children: ReactNode }) => <span>{children}</span>,
    TextInput: ({ accessibilityLabel, onChangeText, value }: { accessibilityLabel: string; onChangeText: (text: string) => void; value: string }) => (
            <textarea aria-label={accessibilityLabel} onChange={(event) => onChangeText(event.target.value)} value={value} />
    ),
    View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}) as never);

const dictation = vi.hoisted(() => {
    return { onText: undefined as ((text: string) => void) | undefined };
});

// eslint-disable-next-line no-restricted-syntax -- the recorder and the speech recognizer are native modules that cannot load in Node
vi.mock(import("../voice/use-dictation"), () => {
    return {
        useDictation: ({ onText }: { onText: (text: string) => void }) => {
            dictation.onText = onText;

            return { error: undefined, finish: async () => {}, phase: "idle" as const, start: async () => {} };
        },
    };
});

// eslint-disable-next-line no-restricted-syntax -- see above: the voice controls only matter on a device
vi.mock(import("../voice/voice-button"), () => {
    return { VoiceButton: () => <span />, VoiceStatus: () => <span /> };
});

const renders = { list: 0, screen: 0 };
/** The store of the screen rendered last, so a test can write to it as the screen's send does. */
const rendered: { store?: DraftStore } = {};

/** Stands in for the message list: it renders exactly when the screen around it does. */
const MessageList = () => {
    renders.list += 1;

    return <ul />;
};

/** The chat screen's wiring: it owns the draft store, the composer subscribes to it. */
const ChatScreen = ({ onSend }: { onSend: () => void }) => {
    const [draft] = useState(createDraftStore);

    renders.screen += 1;
    rendered.store = draft;

    return (
        <>
            <MessageList />
            <ChatComposer control={{ disabled: false, reason: undefined }} draft={draft} isSendBlocked={false} onSend={onSend} safeBottom={0} sendReason={undefined} />
        </>
    );
};

describe(ChatComposer, () => {
    beforeEach(() => {
        renders.list = 0;
        renders.screen = 0;
    });

    afterEach(() => {
        cleanup();
    });

    it("re-renders neither the screen nor its message list while typing", () => {
        render(<ChatScreen onSend={() => {}} />);

        const box = screen.getByLabelText<HTMLTextAreaElement>("Message");

        for (const text of ["H", "He", "Hel", "Hell", "Hello"]) {
            fireEvent.change(box, { target: { value: text } });
        }

        expect(box.value).toBe("Hello");
        expect(rendered.store?.get()).toBe("Hello");
        expect(renders).toStrictEqual({ list: 1, screen: 1 });
    });

    it("puts dictated words into the draft without re-rendering the screen", () => {
        render(<ChatScreen onSend={() => {}} />);
        fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Note:" } });

        act(() => {
            dictation.onText?.("buy milk");
        });

        expect(rendered.store?.get()).toBe("Note: buy milk");
        expect(screen.getByLabelText<HTMLTextAreaElement>("Message").value).toBe("Note: buy milk");
        expect(renders).toStrictEqual({ list: 1, screen: 1 });
    });

    it("shows a draft the screen writes, as a cleared box after a send or a prompt given back", () => {
        const onSend = vi.fn();

        render(<ChatScreen onSend={onSend} />);
        fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Hi" } });
        fireEvent.click(screen.getByText("Send"));

        expect(onSend).toHaveBeenCalledOnce();

        act(() => {
            rendered.store?.set("");
        });

        expect(screen.getByLabelText<HTMLTextAreaElement>("Message").value).toBe("");

        act(() => {
            rendered.store?.set("given back");
        });

        expect(screen.getByLabelText<HTMLTextAreaElement>("Message").value).toBe("given back");
        expect(renders.screen).toBe(1);
    });
});

describe(createDraftStore, () => {
    it("tells subscribers only about a change", () => {
        const store = createDraftStore();
        const listener = vi.fn();
        const unsubscribe = store.subscribe(listener);

        store.set("a");
        store.set("a");
        store.set((current) => `${current}b`);
        unsubscribe();
        store.set("c");

        expect(listener).toHaveBeenCalledTimes(2);
        expect(store.get()).toBe("c");
    });
});
