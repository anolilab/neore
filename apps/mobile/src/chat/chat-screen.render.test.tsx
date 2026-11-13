// @vitest-environment jsdom

/**
 * Renders the production chat screen (`app/chat/[threadId].tsx`) with its native modules and services stubbed at the
 * module boundary, and types, sends and streams a reply through its real composer and `send`: what is measured is the
 * screen's own wiring of the draft store, the batcher, the row writes and the memoised rows, not a copy of it.
 */
import type { ReactNode } from "react";
import { act, createElement, Fragment } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import ChatScreen from "../../app/chat/[threadId]";

const harness = vi.hoisted(() => {
    return {
        /** The reply stream's end, settled by the test. */
        finishReply: undefined as ((outcome: string) => void) | undefined,
        /** Frames requested by the screen, run by the test. */
        frames: [] as (() => void)[],
        /** Whether the chat has history below its newest page, which the screen fills after the paint. */
        hasOlder: false,
        /** Whether the start waits for the test (`settleStart`) instead of answering with a reply stream. */
        holdStart: false,
        /** One entry per render of the message list: it renders exactly when the screen does. */
        listRenders: [] as number[],
        /** Answers a read of an older page; each test that has older history sets it. */
        olderPage: async (_cursor: string): Promise<unknown> => { throw new Error("This test has no older page."); },
        /** The delta handler the screen gave the stream. */
        onDelta: undefined as ((delta: { reasoning: string; text: string }) => void) | undefined,
        /** Settles a held start, as the gateway would. */
        settleStart: undefined as ((outcome: Error) => void) | undefined,
        /** What each `Text` rendered: a row skipped by its memo adds nothing. */
        textRenders: [] as string[],
    };
});

const stable = vi.hoisted(() => {
    const noop = () => {};

    return {
        client: {
            query: async (_query: unknown, args: { paginationOpts: { cursor: string | null } }) => {
                if (args.paginationOpts.cursor !== null) {
                    return await harness.olderPage(args.paginationOpts.cursor);
                }

                return {
                    continueCursor: "older",
                    isDone: !harness.hasOlder,
                    page: [
                        { _creationTime: 1, id: "q1", parts: [{ text: "Why?", type: "text" }], role: "user", status: "success" },
                        { _creationTime: 2, id: "a1", parts: [{ text: "An earlier answer", type: "text" }], role: "assistant", status: "success" },
                    ],
                };
            },
            setAuthToken: noop,
        },
        insets: { bottom: 0, left: 0, right: 0, top: 0 },
        offline: { cache: undefined, refreshTick: 0, reportRead: noop },
        router: { setParams: noop },
        session: { hasToken: true, status: "signed-in", user: { id: "u1" } },
        voice: { error: undefined, finish: async () => {}, phase: "idle", start: async () => {} },
        writeControl: { disabled: false, reason: undefined },
    };
});

// The native primitives as plain DOM elements: `Text` records what it rendered.
// eslint-disable-next-line no-restricted-syntax -- react-native cannot load in Node; the screen imports it directly
vi.mock(import("react-native"), () => ({
    AccessibilityInfo: { announceForAccessibility: () => {} },
    Keyboard: {
        addListener: () => {
            return { remove: () => {} };
        },
    },
    KeyboardAvoidingView: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    Pressable: ({ children, disabled, onPress }: { children: ReactNode; disabled?: boolean; onPress?: () => void }) => (
            <button disabled={disabled} onClick={onPress} type="button">
                {children}
            </button>
    ),
    Share: { share: async () => {} },
    Text: ({ children }: { children: ReactNode }) => {
        harness.textRenders.push(String(children));

        return <span>{children}</span>;
    },
    TextInput: ({ accessibilityLabel, onChangeText, value }: { accessibilityLabel: string; onChangeText: (text: string) => void; value: string }) => (
            <textarea aria-label={accessibilityLabel} onChange={(event) => onChangeText(event.target.value)} value={value} />
    ),
    View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
} as never));

// The list renders every row through the screen's own `renderItem`, as the real one does for the rows on screen.
// eslint-disable-next-line no-restricted-syntax -- the native list cannot load in Node
vi.mock(import("@legendapp/list/react-native"), () => ({
    LegendList: ({
        data,
        keyExtractor,
        ListHeaderComponent,
        renderItem,
    }: {
        data: unknown[];
        keyExtractor: (item: unknown) => string;
        ListHeaderComponent?: ReactNode;
        renderItem: (info: { item: unknown }) => ReactNode;
    }) => {
        harness.listRenders.push(1);

        return (
                <div>
                    {ListHeaderComponent}
                    {data.map((item) => createElement(Fragment, { key: keyExtractor(item) }, renderItem({ item })))}
                </div>
        );
    },
} as never));

// eslint-disable-next-line no-restricted-syntax -- navigation needs a native navigator; the route is fixed here
vi.mock(import("expo-router"), async () => {
    const { useEffect } = await import("react");

    return {
        useFocusEffect: (effect: () => (() => void) | undefined) => {
            useEffect(effect, [effect]);
        },
        useLocalSearchParams: () => {
            return { threadId: "t1" };
        },
        useRouter: () => stable.router,
    } as never;
});

// eslint-disable-next-line no-restricted-syntax -- native module
vi.mock(import("expo-crypto"), () => ({ randomUUID: () => "client-message-id" } as never));

// eslint-disable-next-line no-restricted-syntax -- native module
vi.mock(import("react-native-safe-area-context"), () => ({ useSafeAreaInsets: () => stable.insets } as never));

// eslint-disable-next-line no-restricted-syntax -- the signed-in session comes from the app's provider, absent here
vi.mock(import("@/auth/auth-state"), () => ({ useAuth: () => stable.session } as never));

// eslint-disable-next-line no-restricted-syntax -- the token mint is a network call
vi.mock(import("@/auth/grant"), () => ({ fetchAccessToken: async () => "jwt" } as never));

// eslint-disable-next-line no-restricted-syntax -- secure storage is a native module
vi.mock(import("@/auth/secure-store"), () => ({ secureGrantStore: {} } as never));

// eslint-disable-next-line no-restricted-syntax -- secure storage is a native module
vi.mock(import("@/chat/last-thread-store"), () => ({ forgetLastThread: async () => {}, rememberLastThread: async () => {} } as never));

// The start answers with a reply stream, or waits until the test settles it; everything else of the chat API is real.
// eslint-disable-next-line no-restricted-syntax -- the start is a network call
vi.mock(import("@/chat/chat-api"), async (importOriginal) => {
    const original = await importOriginal<typeof import("@/chat/chat-api")>();
    const started = { contentType: "text/event-stream", messageId: "m2", streamId: "s1", streaming: true, streamToken: "token", threadId: "t1" };

    return {
        ...original,
        startChat: async () => {
            if (!harness.holdStart) {
                return started;
            }

            return await new Promise((_resolve, reject) => {
                harness.settleStart = reject;
            });
        },
    } as never;
});

// The stream hands its delta handler to the test, which plays the reply, and ends when the test says so.
// eslint-disable-next-line no-restricted-syntax -- the reply stream is a network call
vi.mock(import("@/chat/stream"), async (importOriginal) => ({
    ...await importOriginal<typeof import("@/chat/stream")>(),
    relayReply: async ({ onDelta }: { onDelta: (delta: { reasoning: string; text: string }) => void }) => {
        harness.onDelta = onDelta;

        return await new Promise((resolve) => {
            harness.finishReply = resolve;
        });
    },
} as never));

// eslint-disable-next-line no-restricted-syntax -- the build config is read from Expo's native constants
vi.mock(import("@/lib/config"), () => {
    const config = { appUrl: "https://app", gatewayUrl: "https://gateway", lunoraUrl: "https://lunora" };

    return { loadConfig: () => config } as never;
});

// eslint-disable-next-line no-restricted-syntax -- the client opens a socket on import
vi.mock(import("@/lib/lunora"), () => ({ getClient: () => stable.client } as never));

// eslint-disable-next-line no-restricted-syntax -- a native streaming fetch
vi.mock(import("@/lib/streaming-fetch"), () => ({ streamingFetch: async () => new Response() } as never));

// eslint-disable-next-line no-restricted-syntax -- notifications are a native module
vi.mock(import("@/notifications/use-phone-push"), () => ({ offerPhonePush: () => {} } as never));

// eslint-disable-next-line no-restricted-syntax -- the banner reads the app's offline provider, absent here
vi.mock(import("@/offline/offline-banner"), () => ({ OfflineBanner: () => null } as never));

// eslint-disable-next-line no-restricted-syntax -- the offline state comes from the app's provider, absent here
vi.mock(import("@/offline/offline-context"), () => ({ useOffline: () => stable.offline, useWriteControl: () => stable.writeControl } as never));

// eslint-disable-next-line no-restricted-syntax -- the recorder and the speech recognizer are native modules
vi.mock(import("@/voice/use-dictation"), () => ({ useDictation: () => stable.voice } as never));

// eslint-disable-next-line no-restricted-syntax -- see above
vi.mock(import("@/voice/voice-button"), () => ({ VoiceButton: () => null, VoiceStatus: () => null } as never));

const rendered = (text: string): number => harness.textRenders.filter((entry) => entry === text).length;

describe("the chat screen streaming a reply", () => {
    const mounted: { container?: HTMLElement; root?: Root } = {};

    beforeEach(() => {
        harness.holdStart = false;
        harness.frames = [];
        harness.listRenders = [];
        harness.textRenders = [];
        harness.onDelta = undefined;
        harness.finishReply = undefined;
        vi.stubGlobal("requestAnimationFrame", (callback: () => void) => {
            harness.frames.push(callback);

            return harness.frames.length;
        });
        vi.stubGlobal("cancelAnimationFrame", () => {});
        // React reads this to allow `act` outside a testing library.
        Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
        mounted.container = document.createElement("div");
        mounted.root = createRoot(mounted.container);
    });

    afterEach(() => {
        act(() => {
            mounted.root?.unmount();
        });
        vi.unstubAllGlobals();
    });

    it("renders once for a frame of chunks, and only the row the text lands in", async () => {
        act(() => {
            mounted.root?.render(createElement(ChatScreen));
        });
        await vi.waitFor(() => {
            expect(mounted.container?.textContent).toContain("An earlier answer");
        });

        const box = mounted.container?.querySelector<HTMLTextAreaElement>("textarea[aria-label='Message']");
        const send = [...mounted.container?.querySelectorAll("button") ?? []].find((button) => button.textContent === "Send");

        act(() => {
            if (!box) {
                return;
            }

            Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(box, "Go on");
            box.dispatchEvent(new Event("input", { bubbles: true }));
        });
        await act(async () => {
            send?.click();
            await vi.waitFor(() => {
                expect(harness.onDelta).toBeDefined();
            });
        });

        const listBefore = harness.listRenders.length;
        const questionBefore = rendered("Why?");
        const earlierBefore = rendered("An earlier answer");

        act(() => {
            for (const text of ["Be", "cause ", "it ", "is", "."]) {
                harness.onDelta?.({ reasoning: "", text });
            }
        });

        // Nothing is written until the frame.
        expect(harness.listRenders).toHaveLength(listBefore);

        act(() => {
            const due = [...harness.frames];

            harness.frames.length = 0;

            for (const frame of due) {
                frame();
            }
        });

        expect(mounted.container?.textContent).toContain("Because it is.");
        expect(harness.listRenders).toHaveLength(listBefore + 1);
        expect(rendered("Why?")).toBe(questionBefore);
        expect(rendered("An earlier answer")).toBe(earlierBefore);

        await act(async () => {
            harness.finishReply?.("finished");
            await Promise.resolve();
        });
    });
});

describe("the chat screen's composer", () => {
    const mounted: { container?: HTMLElement; root?: Root } = {};

    const messageBox = (): HTMLTextAreaElement => {
        const box = mounted.container?.querySelector<HTMLTextAreaElement>("textarea[aria-label='Message']");

        if (!box) {
            throw new Error("The message box is not on screen.");
        }

        return box;
    };

    const typeInto = (value: string) => {
        act(() => {
            const box = messageBox();

            Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(box, value);
            box.dispatchEvent(new Event("input", { bubbles: true }));
        });
    };

    const openChat = async () => {
        act(() => {
            mounted.root?.render(createElement(ChatScreen));
        });
        await vi.waitFor(() => {
            expect(mounted.container?.textContent).toContain("An earlier answer");
        });
    };

    beforeEach(() => {
        harness.listRenders = [];
        harness.textRenders = [];
        harness.settleStart = undefined;
        harness.holdStart = true;
        // React reads this to allow `act` outside a testing library.
        Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
        mounted.container = document.createElement("div");
        mounted.root = createRoot(mounted.container);
    });

    afterEach(() => {
        act(() => {
            mounted.root?.unmount();
        });
    });

    it("types into the real composer without rendering the screen or its message list again", async () => {
        await openChat();

        const listBefore = harness.listRenders.length;

        for (const text of ["H", "He", "Hel", "Hell", "Hello"]) {
            typeInto(text);
        }

        expect(messageBox().value).toBe("Hello");
        expect(harness.listRenders).toHaveLength(listBefore);
    });

    it("sends the typed prompt, empties the box, and gives the prompt back when the start is refused", async () => {
        const { ChatError } = await import("@/chat/chat-api");

        await openChat();
        typeInto("Go on");

        const send = [...mounted.container?.querySelectorAll("button") ?? []].find((button) => button.textContent === "Send");

        await act(async () => {
            send?.click();
            await vi.waitFor(() => {
                expect(harness.settleStart).toBeDefined();
            });
        });

        // The prompt left the box with the send, and shows as the user's row.
        expect(messageBox().value).toBe("");
        expect(mounted.container?.textContent).toContain("Go on");

        await act(async () => {
            harness.settleStart?.(new ChatError("The message was refused.", { isRefusal: true }));
            await vi.waitFor(() => {
                expect(messageBox().value).toBe("Go on");
            });
        });

        expect(mounted.container?.textContent).toContain("The message was refused.");
    });
});

describe("the chat screen filling its history after the newest page", () => {
    const mounted: { container?: HTMLElement; root?: Root } = {};

    beforeEach(() => {
        harness.hasOlder = true;
        // React reads this to allow `act` outside a testing library.
        Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
        mounted.container = document.createElement("div");
        mounted.root = createRoot(mounted.container);
    });

    afterEach(() => {
        act(() => {
            mounted.root?.unmount();
        });
        harness.hasOlder = false;
    });

    it("shows why an older page of the fill could not be read, as Load older messages does", async () => {
        harness.olderPage = async () => {
            throw new Error("The server could not read older messages.");
        };

        act(() => {
            mounted.root?.render(createElement(ChatScreen));
        });

        await vi.waitFor(() => {
            expect(mounted.container?.textContent).toContain("The server could not read older messages.");
        });
        expect(mounted.container?.textContent).toContain("An earlier answer");
    });
});
