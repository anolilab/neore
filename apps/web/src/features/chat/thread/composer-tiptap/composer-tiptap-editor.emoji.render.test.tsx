/**
 * The `:shortcode` list in the REAL composer editor: typing `:dog` opens the list and names its highlighted row on the
 * editable; the arrows move that highlight; Enter or Tab inserts the emoji in place of the shortcode; Escape closes the
 * list and leaves the text as typed; and a time such as `12:40` never opens it. The editor, its extensions and the list
 * are the real ones; the other popups are stood in for.
 */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createRef } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import type { ComposerTiptapEditorRef } from "./composer-tiptap-editor";
import { loadEmojiIndex } from "./emoji-shortcode/emoji-index";
import { searchEmojiShortcodes } from "./emoji-shortcode/search";

vi.mock("@lingui/react/macro", () => {
    return {
        useLingui: () => {
            return { t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values) };
        },
    };
});

vi.mock("@lingui/core/macro", () => {
    return {
        msg: (strings: TemplateStringsArray) => {
            return { id: strings.join("") };
        },
        plural: (value: number, forms: { one: string; other: string }) => forms.other.split("#").join(String(value)),
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

vi.mock("./slash-command-popup", () => {
    return { default: () => null };
});

vi.mock("./file-mention-popup", () => {
    return { default: () => null };
});

vi.mock("./variable-autocomplete-popup", () => {
    return { default: () => null };
});

// Its reads are covered in `file-mention-popup.prefetch.render.test.tsx`; here it would need a query client and auth.
vi.mock("./use-mention-prefetch", () => {
    return { default: () => false };
});

const { ComposerTiptapEditor } = await import("./composer-tiptap-editor");

const EMOJI_FOUND = /emoji found/;

const renderEditor = () => {
    const ref = createRef<ComposerTiptapEditorRef>();

    render(<ComposerTiptapEditor onChange={vi.fn()} onSubmit={vi.fn()} ref={ref} value="" />);

    return { ref };
};

const typeText = async (ref: React.RefObject<ComposerTiptapEditorRef | null>, text: string): Promise<void> => {
    await waitFor(() => {
        expect(ref.current?.getEditor()).toBeTruthy();
    });

    // Typing happens in the focused editor, which is what gives the list its keys.
    fireEvent.focus(ref.current!.getEditor()!.view.dom);

    act(() => {
        ref.current!.getEditor()!.commands.insertContent(text);
    });
};

// The editable has the combobox role only while the list is open; closed, it is the textbox it always was.
const editableWhileOpen = (): HTMLElement => screen.getByRole("combobox", { name: "Message" });
const editableWhenClosed = (): HTMLElement => screen.getByRole("textbox", { name: "Message" });

const listbox = (): HTMLElement => screen.getByRole("listbox", { name: "Emoji suggestions" });

const optionsOf = async (): Promise<HTMLElement[]> => within(await screen.findByRole("listbox", { name: "Emoji suggestions" })).getAllByRole("option");

describe("composer emoji shortcodes", () => {
    // ProseMirror scrolls the selection into view on every edit; jsdom has no layout for ranges.
    beforeAll(() => {
        Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
        Range.prototype.getBoundingClientRect = () => new DOMRect();
    });

    it("opens the list as the shortcode is typed and names its highlighted row on the editable", async () => {
        const { ref } = renderEditor();

        await typeText(ref, ":dog");

        const options = await optionsOf();
        const expected = searchEmojiShortcodes(await loadEmojiIndex(), "dog");

        expect(options).toHaveLength(expected.length);
        expect(options[0]!.textContent).toContain(`:${expected[0]!.shortcode}:`);
        expect(options[0]!.getAttribute("aria-selected")).toBe("true");
        expect(editableWhileOpen().getAttribute("aria-activedescendant")).toBe(options[0]!.id);
        expect(editableWhileOpen().getAttribute("aria-controls")).toBe(listbox().id);
        expect(editableWhileOpen().getAttribute("aria-expanded")).toBe("true");
        expect(screen.getByRole("status").textContent).toMatch(EMOJI_FOUND);
        // A combobox takes no aria-multiline; the label stays.
        expect(editableWhileOpen().getAttribute("aria-multiline")).toBeNull();
        expect(editableWhileOpen().getAttribute("aria-label")).toBe("Message");
    });

    it("moves the highlight with the arrow keys and inserts the highlighted emoji on Enter", async () => {
        const { ref } = renderEditor();

        await typeText(ref, ":dog");

        const options = await optionsOf();
        const expected = searchEmojiShortcodes(await loadEmojiIndex(), "dog");

        fireEvent.keyDown(editableWhileOpen(), { key: "ArrowDown" });

        expect(options[1]!.getAttribute("aria-selected")).toBe("true");
        expect(editableWhileOpen().getAttribute("aria-activedescendant")).toBe(options[1]!.id);

        fireEvent.keyDown(editableWhileOpen(), { key: "Enter" });

        expect(ref.current?.getEditor()?.getText()).toBe(expected[1]!.emoji);
        expect(screen.queryByRole("listbox", { name: "Emoji suggestions" })).toBeNull();
    });

    it("inserts the highlighted emoji on Tab too, keeping the text around it", async () => {
        const { ref } = renderEditor();

        await typeText(ref, "hi :dog");
        await optionsOf();

        const expected = searchEmojiShortcodes(await loadEmojiIndex(), "dog");

        fireEvent.keyDown(editableWhileOpen(), { key: "Tab" });

        expect(ref.current?.getEditor()?.getText()).toBe(`hi ${expected[0]!.emoji}`);
    });

    it("closes on Escape and leaves the text as typed, until the shortcode ends", async () => {
        const { ref } = renderEditor();

        await typeText(ref, ":dog");
        await optionsOf();

        fireEvent.keyDown(editableWhileOpen(), { key: "Escape" });

        expect(screen.queryByRole("listbox", { name: "Emoji suggestions" })).toBeNull();
        expect(ref.current?.getEditor()?.getText()).toBe(":dog");
        // Closing hands the editable back its textbox role and drops the combobox attributes.
        expect(editableWhenClosed().getAttribute("aria-activedescendant")).toBeNull();
        expect(editableWhenClosed().getAttribute("aria-multiline")).toBe("true");

        await typeText(ref, "s");

        expect(screen.queryByRole("listbox", { name: "Emoji suggestions" })).toBeNull();
        expect(ref.current?.getEditor()?.getText()).toBe(":dogs");
    });

    it("never opens for a time", async () => {
        const { ref } = renderEditor();

        await typeText(ref, "12:40");

        expect(screen.queryByRole("listbox", { name: "Emoji suggestions" })).toBeNull();
        expect(editableWhenClosed().getAttribute("aria-activedescendant")).toBeNull();
    });

    it("closes and stops taking keys once the composer is disabled", async () => {
        const ref = createRef<ComposerTiptapEditorRef>();
        const view = render(<ComposerTiptapEditor onChange={vi.fn()} onSubmit={vi.fn()} ref={ref} value="" />);

        await typeText(ref, ":dog");
        await optionsOf();

        view.rerender(<ComposerTiptapEditor disabled onChange={vi.fn()} onSubmit={vi.fn()} ref={ref} value="" />);

        expect(screen.queryByRole("listbox", { name: "Emoji suggestions" })).toBeNull();
        expect(ref.current?.getEditor()?.getText()).toBe(":dog");
    });

    it("leaves the keys to another field once the editor loses focus", async () => {
        const { ref } = renderEditor();

        render(<input aria-label="Other field" />);
        const other = screen.getByRole("textbox", { name: "Other field" });

        await typeText(ref, ":dog");
        await optionsOf();

        fireEvent.blur(ref.current!.getEditor()!.view.dom);

        expect(screen.queryByRole("listbox", { name: "Emoji suggestions" })).toBeNull();
        // Not prevented: the other field receives its own Enter.
        expect(fireEvent.keyDown(other, { key: "Enter" })).toBe(true);
        expect(ref.current?.getEditor()?.getText()).toBe(":dog");
    });

    it("moves the list with the composer when the page scrolls", async () => {
        const measure = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(10, 200, 300, 20));
        const { ref } = renderEditor();

        await typeText(ref, ":dog");
        await optionsOf();

        measure.mockReturnValue(new DOMRect(40, 260, 300, 20));
        act(() => {
            globalThis.dispatchEvent(new Event("scroll"));
        });

        // The list's fixed box is its parent; its position is what moved.
        // eslint-disable-next-line testing-library/no-node-access -- the positioned box is the element that has to move
        const box = listbox().parentElement!;

        // Measured once the frame that the scroll scheduled has run.
        await waitFor(() => {
            expect(box.style.left).toBe("40px");
        });
        expect(box.style.top).toBe("260px");

        measure.mockRestore();
    });

    it("leaves a shifted arrow to the editor, so it can extend the selection", async () => {
        const { ref } = renderEditor();

        await typeText(ref, ":dog");
        const options = await optionsOf();

        expect(fireEvent.keyDown(editableWhileOpen(), { key: "ArrowDown", shiftKey: true })).toBe(true);
        expect(options[0]!.getAttribute("aria-selected")).toBe("true");
    });

    it("opens for a different shortcode typed over a dismissed one in the same place", async () => {
        const { ref } = renderEditor();

        await typeText(ref, ":dog");
        await optionsOf();
        fireEvent.keyDown(editableWhileOpen(), { key: "Escape" });

        // One edit swaps the shortcode in place, so no moment without a match sits between the two.
        const expected = searchEmojiShortcodes(await loadEmojiIndex(), "cat");

        act(() => {
            ref.current!.getEditor()!.chain().insertContentAt({ from: 1, to: 5 }, ":cat").run();
        });

        const options = await optionsOf();

        expect(options[0]!.textContent).toContain(`:${expected[0]!.shortcode}:`);
    });
});
