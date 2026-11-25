import type { RefObject } from "react";
import { useEffect, useLayoutEffect, useRef } from "react";

import { focusIsLost } from "@/lib/focus-loss";

import { focusComposerWhenMounted } from "./focus-composer";

const paneOf = (container: HTMLElement | null, threadId: string): HTMLElement | null =>
    [...(container?.querySelectorAll<HTMLElement>("[data-pane-thread-id]") ?? [])].find((node) => node.dataset.paneThreadId === threadId) ?? null;

/**
 * Keeps keyboard focus in the split view when focus moves to another pane. Only the focused pane renders the page's header
 * and its composer, so a switch removes whatever control there held focus, and the browser drops it to the page. Then focus
 * goes to the newly focused pane's composer, or its focus button while the composer cannot take it. Nothing moves when focus
 * was somewhere that is still there (the person clicked into the new pane), or nowhere before the switch.
 */
export const useFocusFollowsPaneSwitch = (container: RefObject<HTMLElement | null>, focusedThreadId: string | undefined): void => {
    // The element that last took focus: when it is gone after a switch, the switch removed it.
    const lastFocused = useRef<Element | null>(null);
    const previous = useRef(focusedThreadId);

    useEffect(() => {
        const record = (event: FocusEvent) => {
            lastFocused.current = event.target instanceof Element ? event.target : null;
        };

        document.addEventListener("focusin", record);

        return () => document.removeEventListener("focusin", record);
    }, []);

    // A layout effect: the switch's commit has removed the old pane's controls, and nothing has painted or moved focus since.
    useLayoutEffect(() => {
        const from = previous.current;

        previous.current = focusedThreadId;

        const lost = lastFocused.current;

        if (from === focusedThreadId || from === undefined || focusedThreadId === undefined || lost === null || lost.isConnected || !focusIsLost()) {
            return undefined;
        }

        const pane = { current: paneOf(container.current, focusedThreadId) };

        return focusComposerWhenMounted(pane, (focused) => {
            if (!focused && focusIsLost()) {
                pane.current?.querySelector<HTMLElement>("[data-pane-focus]")?.focus();
            }
        });
    }, [container, focusedThreadId]);
};
