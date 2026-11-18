/**
 * Ctrl+R in the composer: with a search handler wired, the key opens the search and is prevented (the browser would reload);
 * without one, or when the handler declines, the key is left to the browser.
 */
import { act, render, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";

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

vi.mock("./slash-command-popup", () => {
    return { default: () => null };
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

const renderEditor = async (onPromptSearch?: () => boolean) => {
    const ref = createRef<ComposerTiptapEditorRef>();
    const view = render(<ComposerTiptapEditor onChange={vi.fn()} onPromptSearch={onPromptSearch} onSubmit={vi.fn()} ref={ref} value="" />);

    await waitFor(() => {
        expect(ref.current?.getEditor()).toBeTruthy();
    });

    // eslint-disable-next-line testing-library/no-container, testing-library/no-node-access -- the editor has no role to query by
    return { element: view.container.querySelector(".ProseMirror") as HTMLElement };
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
    it("opens the prompt search and prevents the browser reload", async () => {
        const onPromptSearch = vi.fn(() => true);
        const { element } = await renderEditor(onPromptSearch);

        const event = pressCtrlR(element);

        expect(onPromptSearch).toHaveBeenCalledTimes(1);
        expect(event.defaultPrevented).toBe(true);
    });

    it("leaves the key to the browser when the search declines", async () => {
        const onPromptSearch = vi.fn(() => false);
        const { element } = await renderEditor(onPromptSearch);

        const event = pressCtrlR(element);

        expect(onPromptSearch).toHaveBeenCalledTimes(1);
        expect(event.defaultPrevented).toBe(false);
    });

    it("leaves the key to the browser when no search is wired", async () => {
        const { element } = await renderEditor(undefined);

        const event = pressCtrlR(element);

        expect(event.defaultPrevented).toBe(false);
    });
});
