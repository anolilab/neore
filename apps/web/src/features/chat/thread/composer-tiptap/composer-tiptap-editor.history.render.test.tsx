/**
 * Prompt-history recall through the REAL composer editor: ArrowUp at the start of an empty composer shows the last sent
 * prompt. The navigation callback reaches the extension only through the editor's wiring, which broke silently once:
 * tiptap's `extension.options` is a getter that returns a fresh object, so assigning a handler onto it after the
 * editor was built did nothing and ArrowUp inserted a line instead.
 */
import { act, render, waitFor } from "@testing-library/react";
import { createRef, useCallback, useRef } from "react";
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

// `usePromptHistory` is real; only its sibling `<PromptHistorySource>` reads the chat context.
vi.mock("@/features/chat/core/context/chat-context", () => {
    return {
        useChatMessages: () => {
            return { messages: [] };
        },
    };
});

vi.mock("./slash-command-popup", () => {
    return { default: () => null };
});

vi.mock("./file-mention-popup", () => {
    return { default: () => null };
});

vi.mock("./variable-autocomplete-popup", () => {
    return { default: () => null };
});

const { ComposerTiptapEditor } = await import("./composer-tiptap-editor");
const { usePromptHistory } = await import("../use-prompt-history");

/** The composer's history wiring in miniature: a send records the prompt, as the thread's messages would. */
const Harness = ({
    editorRef,
    isStreaming = false,
    onCancel,
}: {
    editorRef: React.RefObject<ComposerTiptapEditorRef | null>;
    isStreaming?: boolean;
    onCancel?: () => void;
}) => {
    const sent = useRef<string[]>([]);
    const getText = useCallback(() => editorRef.current?.getEditor()?.getText() ?? "", [editorRef]);
    const history = usePromptHistory(getText);

    const onSubmit = useCallback(() => {
        const editor = editorRef.current!.getEditor()!;

        sent.current = [editor.getText(), ...sent.current];
        history.setEntries(sent.current);
        history.reset();
        editor.commands.clearContent(true);
    }, [editorRef, history]);

    return (
        <ComposerTiptapEditor
            isStreaming={isStreaming}
            onCancel={onCancel}
            onChange={history.onTextChange}
            onHistoryNavigate={history.navigate}
            onSubmit={onSubmit}
            ref={editorRef}
            value=""
        />
    );
};

/** A key as the keyboard sends it: to whatever has the focus, which must still be the editor. */
const press = (element: HTMLElement, key: string) => {
    /* eslint-disable testing-library/no-node-access -- the focused element is what is under test: a key goes where focus is */
    expect(document.activeElement).toBe(element);
    act(() => {
        document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key }));
    });
    /* eslint-enable testing-library/no-node-access */
};

describe("ComposerTiptapEditor prompt history", () => {
    // ProseMirror scrolls the selection into view on every edit; jsdom has no layout for ranges.
    beforeAll(() => {
        Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
        Range.prototype.getBoundingClientRect = () => new DOMRect();
    });

    it("recalls the previous prompts with ArrowUp and walks back with ArrowDown", async () => {
        const ref = createRef<ComposerTiptapEditorRef>();
        const view = render(<Harness editorRef={ref} />);

        await waitFor(() => {
            expect(ref.current?.getEditor()).toBeTruthy();
        });

        const editor = ref.current!.getEditor()!;
        // eslint-disable-next-line testing-library/no-container, testing-library/no-node-access -- the editor has no role to query by
        const element = view.container.querySelector(".ProseMirror") as HTMLElement;

        for (const prompt of ["first prompt", "second prompt"]) {
            act(() => {
                editor.commands.focus();
                element.focus();
                editor.commands.insertContent(prompt);
            });
            press(element, "Enter");
        }

        expect(editor.getText()).toBe("");

        act(() => {
            editor.commands.focus("start");
            element.focus();
        });
        press(element, "ArrowUp");

        expect(editor.getText()).toBe("second prompt");

        press(element, "ArrowUp");

        expect(editor.getText()).toBe("first prompt");

        act(() => {
            editor.commands.focus("end");
            element.focus();
        });
        press(element, "ArrowDown");

        expect(editor.getText()).toBe("second prompt");
    });

    it("sends with Enter while a slash match has no menu (text after /compact)", async () => {
        const ref = createRef<ComposerTiptapEditorRef>();
        const view = render(<Harness editorRef={ref} />);

        await waitFor(() => {
            expect(ref.current?.getEditor()).toBeTruthy();
        });

        const editor = ref.current!.getEditor()!;
        // eslint-disable-next-line testing-library/no-container, testing-library/no-node-access -- the editor has no role to query by
        const element = view.container.querySelector(".ProseMirror") as HTMLElement;

        act(() => {
            editor.commands.focus();
            element.focus();
            editor.commands.insertContent("/compact keep the code");
        });
        press(element, "Enter");

        expect(editor.getText()).toBe("");
    });

    it("cancels a reply that started streaming after the editor was built with Escape, and lets Escape through otherwise", async () => {
        const ref = createRef<ComposerTiptapEditorRef>();
        const onCancel = vi.fn();
        const view = render(<Harness editorRef={ref} onCancel={onCancel} />);

        await waitFor(() => {
            expect(ref.current?.getEditor()).toBeTruthy();
        });

        const editor = ref.current!.getEditor()!;
        // eslint-disable-next-line testing-library/no-container, testing-library/no-node-access -- the editor has no role to query by
        const element = view.container.querySelector(".ProseMirror") as HTMLElement;

        act(() => {
            editor.commands.focus();
            element.focus();
        });
        press(element, "Escape");

        expect(onCancel).not.toHaveBeenCalled();

        view.rerender(<Harness editorRef={ref} isStreaming onCancel={onCancel} />);
        press(element, "Escape");

        expect(onCancel).toHaveBeenCalledOnce();
    });
});
