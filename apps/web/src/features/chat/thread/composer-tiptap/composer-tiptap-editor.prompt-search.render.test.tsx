/**
 * Ctrl+R in the composer: with a search handler wired, the key opens the search and is prevented (the browser would reload);
 * without one, or when the handler declines, the key is left to the browser.
 */
import { act, render, waitFor } from "@testing-library/react";
import type { RefObject } from "react";
import { createRef, useState } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import type { ComposerTiptapEditorRef } from "./composer-tiptap-editor";

vi.mock("@lingui/react/macro", () => {
    return {
        useLingui: () => {
            return { t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values) };
        },
    };
});

vi.mock("@/features/auth/hooks/use-user-settings", () => {
    return {
        useUserSettings: () => {
            return { data: null };
        },
    };
});

vi.mock("@/features/chat/core/hooks/use-favorite-models", () => {
    return {
        default: () => {
            return { favoriteModelIds: [] };
        },
    };
});

vi.mock("@/hooks/use-feature-flagged-models", () => {
    return { default: () => [] };
});

vi.mock("@lingui/core/macro", () => {
    return {
        msg: (strings: TemplateStringsArray) => {
            return { id: strings.join("") };
        },
    };
});

// The slash menu's open state, as the popup is handed it: an open menu takes the arrows, Enter and Escape on `window`.
const slashMenu = vi.hoisted(() => {
    return { open: false };
});

vi.mock("./slash-command-popup", () => {
    return {
        default: ({ match }: { match: unknown }) => {
            slashMenu.open = match !== null;

            return null;
        },
    };
});

vi.mock("./file-mention-popup", () => {
    return { default: () => null };
});

vi.mock("./use-mention-prefetch", () => {
    return { default: () => false };
});

vi.mock("./variable-autocomplete-popup", () => {
    return { default: () => null };
});

const { ComposerTiptapEditor } = await import("./composer-tiptap-editor");

/** The editor with its draft held in state, as the composer holds it: a fixed `value` would undo every edit. */
const Controlled = ({ editorRef, onPromptSearch }: { editorRef: RefObject<ComposerTiptapEditorRef | null>; onPromptSearch?: () => boolean }) => {
    const [value, setValue] = useState("");

    return <ComposerTiptapEditor onChange={setValue} onPromptSearch={onPromptSearch} onSubmit={vi.fn()} ref={editorRef} value={value} />;
};

const renderEditor = async (onPromptSearch?: () => boolean) => {
    const ref = createRef<ComposerTiptapEditorRef>();
    const view = render(<Controlled editorRef={ref} onPromptSearch={onPromptSearch} />);

    await waitFor(() => {
        expect(ref.current?.getEditor()).toBeTruthy();
    });

    // eslint-disable-next-line testing-library/no-container, testing-library/no-node-access -- the editor has no role to query by
    return { element: view.container.querySelector(".ProseMirror") as HTMLElement, ref };
};

const pressCtrlR = (element: HTMLElement) => {
    const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ctrlKey: true, key: "r" });

    act(() => {
        element.focus();
        element.dispatchEvent(event);
    });

    return event;
};

describe("ComposerTiptapEditor Ctrl+R", () => {
    // ProseMirror scrolls the selection into view on every edit; jsdom has no layout for ranges.
    beforeAll(() => {
        Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
        Range.prototype.getBoundingClientRect = () => new DOMRect();
    });

    it("opens the prompt search and prevents the browser reload", async () => {
        const onPromptSearch = vi.fn(() => true);
        const { element } = await renderEditor(onPromptSearch);

        const event = pressCtrlR(element);

        expect(onPromptSearch).toHaveBeenCalledTimes(1);
        expect(event.defaultPrevented).toBe(true);
    });

    it("keeps a taken Ctrl+R from a shortcut recorded on the same key", async () => {
        const reached = vi.fn();

        document.addEventListener("keydown", reached);

        try {
            const { element } = await renderEditor(vi.fn(() => true));

            pressCtrlR(element);

            expect(reached).not.toHaveBeenCalled();
        } finally {
            document.removeEventListener("keydown", reached);
        }
    });

    it("leaves the key to the browser when the search declines", async () => {
        const onPromptSearch = vi.fn(() => false);
        const { element } = await renderEditor(onPromptSearch);

        const event = pressCtrlR(element);

        expect(onPromptSearch).toHaveBeenCalledTimes(1);
        expect(event.defaultPrevented).toBe(false);
    });

    it("closes an open slash menu, so the search gets the keys the menu would take", async () => {
        const { element, ref } = await renderEditor(vi.fn(() => true));

        act(() => {
            ref.current?.getEditor()?.commands.insertContent("/");
        });

        await waitFor(() => {
            expect(slashMenu.open).toBe(true);
        });

        pressCtrlR(element);

        await waitFor(() => {
            expect(slashMenu.open).toBe(false);
        });
    });

    it("leaves the key to the browser when no search is wired", async () => {
        const { element } = await renderEditor(undefined);

        const event = pressCtrlR(element);

        expect(event.defaultPrevented).toBe(false);
    });
});
