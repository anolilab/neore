/**
 * What the editor says for the suggested next prompt: the text is announced once when it is placed, the announcement
 * clears after ANNOUNCEMENT_CLEAR_MS, a newer suggestion runs on its own clock, and a suggestion that goes away takes its
 * announcement with it. Fake timers drive the clock; the editor, its extensions and the announcement effect are real.
 */
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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

// The popups need a query client and auth; they are not part of the announcement.
vi.mock("./slash-command-popup", () => {
    return { default: () => null };
});

vi.mock("./file-mention-popup", () => {
    return { default: () => null };
});

vi.mock("./variable-autocomplete-popup", () => {
    return { default: () => null };
});

vi.mock("./use-mention-prefetch", () => {
    return { default: () => false };
});

const { ComposerTiptapEditor } = await import("./composer-tiptap-editor");

// Mirrors the editor's clear delay for its live announcements.
const ANNOUNCEMENT_CLEAR_MS = 4000;

const editorWith = (nextPromptSuggestion: string | null, value = "", requestCompletion?: () => Promise<string | null>) => (
    <ComposerTiptapEditor
        nextPromptScope="thread-1"
        nextPromptSuggestion={nextPromptSuggestion}
        onChange={() => {}}
        onSubmit={() => {}}
        requestCompletion={requestCompletion}
        value={value}
    />
);

// The announced text of the live region that carries the prompt, or null when none does.
const announcedText = () =>
    screen
        .queryAllByRole("status")
        .map((region) => region.textContent)
        .find((text) => text?.includes("Suggested next prompt")) ?? null;

const tick = (ms: number) => {
    act(() => {
        vi.advanceTimersByTime(ms);
    });
};

describe("the suggested next prompt announcement", () => {
    // ProseMirror scrolls the selection into view on every edit; jsdom has no layout for ranges.
    beforeAll(() => {
        Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
        Range.prototype.getBoundingClientRect = () => new DOMRect();
    });

    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("says the suggestion when it is placed, then clears the announcement after the clear delay", () => {
        render(editorWith("Summarize it"));

        expect(announcedText()).toBe("Suggested next prompt: Summarize it. Press Tab to insert.");

        tick(ANNOUNCEMENT_CLEAR_MS - 1);
        expect(announcedText()).not.toBeNull();

        tick(1);
        expect(announcedText()).toBeNull();
    });

    it("says nothing while the composer already has text", () => {
        render(editorWith("Summarize it", "draft"));
        tick(ANNOUNCEMENT_CLEAR_MS);

        expect(announcedText()).toBeNull();
    });

    it("a newer suggestion is said on its own clock: the earlier timer does not clear it", () => {
        const view = render(editorWith("First"));

        tick(3000);
        view.rerender(editorWith("Second"));
        expect(announcedText()).toBe("Suggested next prompt: Second. Press Tab to insert.");

        // Six seconds after "First", three after "Second": the first timer would have cleared it by now.
        tick(3000);
        expect(announcedText()).toBe("Suggested next prompt: Second. Press Tab to insert.");

        tick(1000);
        expect(announcedText()).toBeNull();
    });

    it("a suggestion that goes away takes its announcement with it", () => {
        const view = render(editorWith("Summarize it"));

        view.rerender(editorWith(null));

        expect(announcedText()).toBeNull();
    });

    // With a ghost completion source the live region stays mounted after the prompt goes, so a stale line would stay in it.
    it("a suggestion that goes away takes its announcement with it while the ghost completion keeps the region mounted", () => {
        const requestCompletion = () => Promise.resolve(null);
        const view = render(editorWith("Summarize it", "", requestCompletion));

        expect(announcedText()).toBe("Suggested next prompt: Summarize it. Press Tab to insert.");

        view.rerender(editorWith(null, "", requestCompletion));

        expect(announcedText()).toBeNull();
    });
});
