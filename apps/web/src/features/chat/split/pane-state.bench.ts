// Benchmarks run only under `vitest bench`, so the devDependency is correct here.
// eslint-disable-next-line import/no-extraneous-dependencies
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { useChatUIStore } from "@/features/chat/core/stores/chat-ui-store";

import { clearComposerDrafts, setSplitViewMounted } from "./composer-drafts";
import { syncFocusedModel, watchPaneFocus } from "./pane-state";
import { initialSplitLayout, MAX_PANES, splitLayoutReducer } from "./split-layout";
import { useSplitLayoutStore } from "./split-layout-store";

const threads = Array.from({ length: MAX_PANES }, (_, index) => `thread-${index}`);

const watcher: { stop?: () => void } = {};

const openThreePanes = (): void => {
    let layout = initialSplitLayout();

    for (const threadId of threads) {
        layout = splitLayoutReducer(layout, { threadId, type: "open" });
    }

    useSplitLayoutStore.setState({ layout });
};

beforeAll(() => {
    setSplitViewMounted(true);
    openThreePanes();
    watcher.stop = watchPaneFocus();
    // A draft in the live composer, so every switch parks it and brings it back.
    useChatUIStore.getState().setComposerText("a half-written reply");
});

afterAll(() => {
    watcher.stop?.();
    setSplitViewMounted(false);
    clearComposerDrafts();
    useSplitLayoutStore.setState({ layout: initialSplitLayout() });
});

describe("split view with three panes", () => {
    test("layout changes, with the focus watcher attached", async ({ bench }) => {
        // The watcher runs on every layout change, so a divider drag pays for it on each pointer move.
        let sizeTurn = 0;
        // Read once, so the timed loop does not go through the store's module export on every call.
        const { dispatch } = useSplitLayoutStore.getState();

        await bench("resize dispatch", () => {
            sizeTurn = 1 - sizeTurn;

            dispatch({
                sizes: { [threads[0] as string]: 40 + sizeTurn, [threads[1] as string]: 30, [threads[2] as string]: 30 - sizeTurn },
                type: "resize",
            });
        }).run();

        // Checks the benchmark ran on the three panes it was meant to measure.
        expect(useSplitLayoutStore.getState().layout.panes).toHaveLength(MAX_PANES);
    });

    test("focus switches between panes", async ({ bench }) => {
        // Moving focus parks the outgoing chat, then the incoming chat's sync loads its model.
        let focusTurn = 0;
        const { dispatch } = useSplitLayoutStore.getState();

        await bench("focus switch: park the outgoing chat, sync the incoming one", () => {
            focusTurn = (focusTurn + 1) % MAX_PANES;

            const threadId = threads[focusTurn] as string;

            dispatch({ index: focusTurn, type: "focus" });
            syncFocusedModel({ isLoaded: true, mode: "text", model: "model", threadId });
        }).run();

        expect(useSplitLayoutStore.getState().layout.focus).toBe(focusTurn);
    });
});
