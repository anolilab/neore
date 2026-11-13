// @vitest-environment jsdom
import { act, createElement, useEffect } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Confirmation, ConfirmPage } from "./reply-confirmation";
import { CONFIRM_READ_INTERVAL_MS } from "./reply-confirmation";
import { useReplyConfirmation } from "./use-reply-confirmation";

// The send is on the newest page and its reply is still being written, so every check reads one page and goes on.
const fetchPage = vi.fn(
    async (): Promise<ConfirmPage> => {
        return {
            continueCursor: "older",
            isDone: false,
            page: [
                { id: "sent", role: "user", status: "success" },
                { id: "reply", role: "assistant", status: "pending" },
            ],
        };
    },
);
const onEnded = () => {};
const onRefused = () => {};
const pending: Confirmation = { holdsSend: false, messageId: "sent", steers: 0, threadId: "t1" };

/** A chat screen that has just sent: one confirmation waits, and `isPaused` is whether it is on screen and in front. */
const Chat = ({ isPaused }: { isPaused: boolean }) => {
    const { addConfirmation } = useReplyConfirmation({ fetchPage, isPaused, onEnded, onRefused, threadId: "t1" });

    useEffect(() => {
        addConfirmation(pending);
    }, [addConfirmation]);

    return null;
};

describe(useReplyConfirmation, () => {
    const mounted: { root?: Root } = {};

    const show = (isPaused: boolean) => {
        act(() => {
            mounted.root?.render(createElement(Chat, { isPaused }));
        });
    };

    /** Lets `ticks` check intervals pass, with each check's page read settled. */
    const wait = async (ticks: number) => {
        await act(async () => {
            await vi.advanceTimersByTimeAsync(ticks * CONFIRM_READ_INTERVAL_MS);
        });
    };

    beforeEach(() => {
        vi.useFakeTimers();
        fetchPage.mockClear();
        // React reads this to allow `act` outside a testing library.
        Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
        mounted.root = createRoot(document.createElement("div"));
    });

    afterEach(() => {
        act(() => {
            mounted.root?.unmount();
        });
        vi.useRealTimers();
    });

    it("checks a waiting reply every interval while the chat is shown", async () => {
        show(false);
        await wait(3);

        expect(fetchPage).toHaveBeenCalledTimes(3);
    });

    it("reads nothing while the chat is behind another screen or the app is in the background", async () => {
        show(false);
        await wait(1);
        show(true);
        await wait(30);

        expect(fetchPage).toHaveBeenCalledTimes(1);
    });

    it("goes on checking once the chat is shown again", async () => {
        show(true);
        await wait(5);
        show(false);
        await wait(2);

        expect(fetchPage).toHaveBeenCalledTimes(2);
    });
});
