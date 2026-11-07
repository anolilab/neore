// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { useThreadListUIStore } from "../stores/thread-list-ui-store";
import type { BranchNode } from "../types";
import useKeyboardNavigation from "./use-keyboard-navigation";
import useThreadListKeyboard from "./use-thread-list-keyboard";

const LOCKED_AT = 1_700_000_000_000;

/** The rows a test hides: they stay mounted but have no box, as a row under a collapsed sidebar does. */
const hidden = new Set<string>();

/** A row with a box, as a laid-out row has; jsdom does no layout of its own. Stable, so a re-render does not lay a hidden row out again. */
const laidOut = (element: HTMLElement | null): void => {
    if (!element) {
        return;
    }

    const shown = !hidden.has(element.dataset.threadId ?? "");

    Object.assign(element, { getClientRects: () => (shown ? [{}] : []) });
};

/** The list's keyboard wiring, as `HierarchicalThreadList` has it: the navigation's selection feeds the key handler. */
const ListKeyboard = ({ threads }: { threads: BranchNode[] }) => {
    const navigation = useKeyboardNavigation({ flattenedThreads: threads, navigate: () => {} });

    useThreadListKeyboard({
        handleArrowDown: navigation.handleArrowDown,
        handleArrowUp: navigation.handleArrowUp,
        handleEnter: navigation.handleEnter,
        handleKeyboardEscape: navigation.handleEscape,
        handleOpenSelectedMenu: navigation.handleOpenSelectedMenu,
        handleRenameSelected: navigation.handleRenameSelected,
        handleSelectAll: () => {},
        isKeyboardNavigating: navigation.isKeyboardNavigating,
        isSelectionMode: false,
        navigate: () => {},
        onExitSelectionMode: () => {},
        selectedThreadIndex: navigation.selectedThreadIndex,
        setShowKeyboardHelp: () => {},
    });

    // The rows the list has mounted: a thread the virtualizer has not mounted has no row here.
    return (
        <div>
            {threads.map((node) => (
                <div data-thread-id={node.threadId} key={node.threadId} ref={laidOut}>
                    {node.threadId}
                </div>
            ))}
        </div>
    );
};

const row = (threadId: string, lockedAt: number | null): BranchNode => ({ lockedAt, threadId }) as BranchNode;

describe("the context-menu key", () => {
    beforeEach(() => {
        hidden.clear();
        useThreadListUIStore.getState().setOptionsMenuThreadId(null);
        useThreadListUIStore.getState().setRenameThreadId(null);
    });

    it("leaves a locked row to the browser and opens no menu, as a mouse click on that row gets none", () => {
        render(<ListKeyboard threads={[row("locked", LOCKED_AT)]} />);

        fireEvent.keyDown(document.body, { key: "ArrowDown" });

        // fireEvent returns false when the key was cancelled: here it must not be.
        expect(fireEvent.keyDown(document.body, { key: "ContextMenu" })).toBe(true);
        expect(useThreadListUIStore.getState().optionsMenuThreadId).toBeNull();
    });

    it("cancels the key and opens the menu of a shown, unlocked row", () => {
        render(<ListKeyboard threads={[row("open", null)]} />);

        fireEvent.keyDown(document.body, { key: "ArrowDown" });

        expect(fireEvent.keyDown(document.body, { key: "ContextMenu" })).toBe(false);
        expect(useThreadListUIStore.getState().optionsMenuThreadId).toBe("open");
    });

    it("does nothing for a selected row the list has unmounted, so no menu appears when it mounts later", () => {
        const threads = [row("scrolled-out", null)];
        const { rerender } = render(<ListKeyboard threads={threads} />);

        fireEvent.keyDown(document.body, { key: "ArrowDown" });
        // The virtualizer unmounts the row: nothing is mounted for the selected thread.
        rerender(<ListKeyboard threads={[]} />);

        expect(fireEvent.keyDown(document.body, { key: "ContextMenu" })).toBe(true);
        expect(useThreadListUIStore.getState().optionsMenuThreadId).toBeNull();

        // The row mounts again: no menu opens from the earlier key.
        rerender(<ListKeyboard threads={threads} />);
        expect(useThreadListUIStore.getState().optionsMenuThreadId).toBeNull();
    });

    it("does nothing for a selected row that is mounted but not laid out, as in a hidden sidebar", () => {
        hidden.add("hidden");
        render(<ListKeyboard threads={[row("hidden", null)]} />);

        fireEvent.keyDown(document.body, { key: "ArrowDown" });

        expect(fireEvent.keyDown(document.body, { key: "ContextMenu" })).toBe(true);
        expect(useThreadListUIStore.getState().optionsMenuThreadId).toBeNull();
    });

    it("acts on the selected row while focus is in the sidebar", () => {
        render(
            <div data-focus-area="sidebar">
                <ListKeyboard threads={[row("in-sidebar", null)]} />
            </div>,
        );

        fireEvent.keyDown(document.body, { key: "ArrowDown" });
        // eslint-disable-next-line testing-library/no-node-access -- the selected row is the element the keys are sent to
        fireEvent.keyDown(document.querySelector('[data-thread-id="in-sidebar"]') as HTMLElement, { key: "F2" });

        expect(useThreadListUIStore.getState().renameThreadId).toBe("in-sidebar");
    });

    it("leaves F2 and the context-menu key to a focused area outside the sidebar, once F6 has moved focus there", () => {
        render(<ListKeyboard threads={[row("remembered", null)]} />);

        fireEvent.keyDown(document.body, { key: "ArrowDown" });

        const composer = document.createElement("button");

        document.body.appendChild(composer);
        composer.focus();

        fireEvent.keyDown(composer, { key: "F2" });
        expect(useThreadListUIStore.getState().renameThreadId).toBeNull();

        expect(fireEvent.keyDown(composer, { key: "ContextMenu" })).toBe(true);
        expect(useThreadListUIStore.getState().optionsMenuThreadId).toBeNull();

        composer.remove();
    });
});

describe("F2 and the context-menu key after F6 moves focus", () => {
    beforeEach(() => {
        useThreadListUIStore.getState().setOptionsMenuThreadId(null);
    });

    it("leaves F2 and the menu key to an area outside the sidebar that F6 moved focus into", () => {
        render(
            <>
                <ListKeyboard threads={[row("open", null)]} />
                <div data-focus-area="composer">
                    <button type="button">Composer</button>
                </div>
            </>,
        );

        fireEvent.keyDown(document.body, { key: "ArrowDown" });
        screen.getByRole("button", { name: "Composer" }).focus();

        expect(fireEvent.keyDown(screen.getByRole("button", { name: "Composer" }), { key: "F2" })).toBe(true);
        expect(fireEvent.keyDown(screen.getByRole("button", { name: "Composer" }), { key: "ContextMenu" })).toBe(true);
        expect(useThreadListUIStore.getState().optionsMenuThreadId).toBeNull();
    });

    it("handles the menu key while focus stays in the sidebar", () => {
        render(
            <div data-focus-area="sidebar">
                <ListKeyboard threads={[row("open", null)]} />
            </div>,
        );

        fireEvent.keyDown(document.body, { key: "ArrowDown" });

        expect(fireEvent.keyDown(document.body, { key: "ContextMenu" })).toBe(false);
        expect(useThreadListUIStore.getState().optionsMenuThreadId).toBe("open");
    });
});
