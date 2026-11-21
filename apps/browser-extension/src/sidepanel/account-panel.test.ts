import { describe, expect, it } from "vitest";

import type { AccountPanel } from "./account-panel";
import { panelFor, subscribeWhileCurrent, withCreatedThread } from "./account-panel";

const chatOf = (userId: string): AccountPanel => {
    return {
        activeOrgId: "org-1",
        userId,
        view: { key: "view-1", seed: { autoSend: "Translate", id: "seed-1" }, threadId: "thread-1", type: "chat" },
    };
};

describe(panelFor, () => {
    it("drops another account's chat, seed and organization", () => {
        expect(panelFor(chatOf("u1"), "u2")).toEqual({ activeOrgId: null, userId: "u2", view: { type: "threads" } });
    });

    it("keeps the same account's chat, whatever the grant", () => {
        const panel = chatOf("u1");

        expect(panelFor(panel, "u1")).toBe(panel);
    });
});

describe(withCreatedThread, () => {
    const newChat: AccountPanel = { activeOrgId: null, userId: "u1", view: { key: "view-2", threadId: null, type: "chat" } };

    it("gives the chat that sent the first message its thread", () => {
        expect(withCreatedThread(newChat, "view-2", "thread-2").view).toEqual({ key: "view-2", threadId: "thread-2", type: "chat" });
    });

    it("leaves a chat opened since alone", () => {
        expect(withCreatedThread(newChat, "view-1", "thread-1")).toBe(newChat);
        expect(withCreatedThread({ ...newChat, view: { type: "threads" } }, "view-2", "thread-2").view).toEqual({ type: "threads" });
    });
});

describe(subscribeWhileCurrent, () => {
    const fakeSubscription = () => {
        const state: { deliver?: (request: string) => void; unsubscribed: boolean } = { unsubscribed: false };
        const subscribe = (onRequest: (request: string) => void) => {
            state.deliver = onRequest;

            return () => {
                state.unsubscribed = true;
            };
        };

        return { state, subscribe };
    };

    it("opens a request that resolves while still subscribed", async () => {
        const { state, subscribe } = fakeSubscription();
        const opened: string[] = [];
        let seeded: Promise<() => void> | undefined;

        subscribeWhileCurrent(subscribe, (request) => {
            seeded = (async () => {
                await Promise.resolve();

                return () => {
                    opened.push(request);
                };
            })();

            return seeded;
        });
        state.deliver?.("translate");
        await seeded;

        expect(opened).toEqual(["translate"]);
    });

    it("drops a request that resolves after unsubscribing", async () => {
        const { state, subscribe } = fakeSubscription();
        const opened: string[] = [];
        let seeded: Promise<() => void> | undefined;

        // Another account signs in while the settings read is still pending.
        const unsubscribe = subscribeWhileCurrent(subscribe, (request) => {
            seeded = (async () => {
                await Promise.resolve();
                unsubscribe();

                return () => {
                    opened.push(request);
                };
            })();

            return seeded;
        });

        state.deliver?.("translate");
        await seeded;

        expect(state.unsubscribed).toBe(true);
        expect(opened).toEqual([]);
    });
});
