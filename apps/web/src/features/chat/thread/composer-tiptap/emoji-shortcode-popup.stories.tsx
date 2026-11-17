import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, within } from "storybook/test";

import { loadEmojiIndex } from "./emoji-shortcode/emoji-index";
import type { EmojiSuggestion } from "./emoji-shortcode/search";
import { searchEmojiShortcodes } from "./emoji-shortcode/search";
import EmojiShortcodePopup from "./emoji-shortcode-popup";

/** The composer's box as the popup reads it: the list sits above `top`, so `top` is the room it has. */
const composerRect = (top: number): DOMRect => new DOMRect(120, top, 520, 44);

/** The rows the composer shows for `query`, from the real emoji index. */
const suggestionsFor = async (query: string): Promise<ReadonlyArray<EmojiSuggestion>> => searchEmojiShortcodes(await loadEmojiIndex(), query);

// The index loads before the story renders; the rows reach the popup through `loaded`, not through args.
const rowsFor = (query: string): Pick<Story, "loaders" | "render"> => {
    return {
        loaders: [
            async () => {
                return { rows: await suggestionsFor(query) };
            },
        ],
        render: (args, { loaded }) => <EmojiShortcodePopup {...args} suggestions={loaded.rows as ReadonlyArray<EmojiSuggestion>} />,
    };
};

// The popup is portalled to the body, so the story looks there, not in its canvas.
const listboxIn = (): HTMLElement => within(document.body).getByRole("listbox", { name: "Emoji suggestions" });

const meta = {
    args: {
        editorRect: composerRect(480),
        listboxId: "emoji-story",
        onHighlight: fn(),
        onSelect: fn(),
        open: true,
        selected: 0,
        suggestions: [],
    },
    component: EmojiShortcodePopup,
    title: "Chat/Emoji shortcode popup",
} satisfies Meta<typeof EmojiShortcodePopup>;

export default meta;

type Story = StoryObj<typeof meta>;

/** `:spee` as typed: prefix matches first, each row with its glyph and the typed part in bold. */
export const Default: Story = {
    ...rowsFor("spee"),
    play: async () => {
        const options = within(listboxIn()).getAllByRole("option");

        expect(options.length).toBeGreaterThan(0);
        expect(options[0]!.getAttribute("aria-selected")).toBe("true");
        expect(options[0]!.textContent).toContain(":speedboat:");
    },
};

/** The arrow keys move the highlight; the editable names this row through aria-activedescendant. */
export const HighlightedRow: Story = {
    ...rowsFor("o"),
    args: { selected: 2 },
    play: async () => {
        const options = within(listboxIn()).getAllByRole("option");

        expect(options[2]!.getAttribute("aria-selected")).toBe("true");
        expect(options[0]!.getAttribute("aria-selected")).toBe("false");
    },
};

/** The most rows the composer shows at once. */
export const FullList: Story = {
    ...rowsFor("o"),
    play: async () => {
        expect(within(listboxIn()).getAllByRole("option")).toHaveLength(8);
    },
};

/**
 * A composer near the top of the window: the list is capped to the room above it and scrolls, and the highlighted row
 * at the bottom of the list is brought into view.
 */
export const ShortViewport: Story = {
    ...rowsFor("o"),
    args: { editorRect: composerRect(120), selected: 7 },
    play: async () => {
        const listbox = listboxIn();
        const options = within(listbox).getAllByRole("option");

        expect(listbox.style.maxHeight).toBe("114px");
        expect(options[7]!.getAttribute("aria-selected")).toBe("true");
    },
};
