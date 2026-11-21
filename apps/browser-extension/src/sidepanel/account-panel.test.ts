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

    /** A seed that waits on `seeded`; `resolved` settles just after the panel had its chance to apply it. */
    const seededOpen = (opened: string[]) => {
        const seeded = Promise.withResolvers<undefined>();
        const resolved: Promise<() => void>[] = [];
        const resolve = (request: string) => {
            const update = (async () => {
                await seeded.promise;

                return () => {
                    opened.push(request);
                };
            })();

            resolved.push(update);

            return update;
        };

        return { resolve, resolved, seeded };
    };

    it("opens a request that resolves while still subscribed", async () => {
        const { state, subscribe } = fakeSubscription();
        const opened: string[] = [];
        const { resolve, resolved, seeded } = seededOpen(opened);

        subscribeWhileCurrent(subscribe, resolve);
        state.deliver?.("translate");
        seeded.resolve(undefined);
        await Promise.all(resolved);

        expect(opened).toEqual(["translate"]);
    });

    it("drops a request that resolves after unsubscribing", async () => {
        const { state, subscribe } = fakeSubscription();
        const opened: string[] = [];
        const { resolve, resolved, seeded } = seededOpen(opened);
        const unsubscribe = subscribeWhileCurrent(subscribe, resolve);

        state.deliver?.("translate");
        unsubscribe();
        seeded.resolve(undefined);
        await Promise.all(resolved);

        expect(state.unsubscribed).toBe(true);
        expect(opened).toEqual([]);
    });
});
