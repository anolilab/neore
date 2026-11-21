/**
 * What the editor says for the suggested next prompt: the text is announced once when it is placed, the announcement
 * clears after ANNOUNCEMENT_CLEAR_MS, a newer suggestion runs on its own clock, and a suggestion that goes away takes its
 * announcement with it. Fake timers drive the clock; the editor, its extensions and the announcement effect are real.
 */
import { act, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { ComposerTiptapEditorRef } from "./composer-tiptap-editor";
import { getGhostCompletion } from "./extensions/ghost-completion";

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

    it("the same prompt for another chat is said again: cleared at once, then restored in a later task", () => {
        const chat = (scope: string) => (
            <ComposerTiptapEditor nextPromptScope={scope} nextPromptSuggestion="Same" onChange={() => {}} onSubmit={() => {}} value="" />
        );
        const view = render(chat("thread-1"));

        expect(announcedText()).toBe("Suggested next prompt: Same. Press Tab to insert.");

        view.rerender(chat("thread-2"));

        expect(announcedText()).toBeNull();

        tick(0);

        expect(announcedText()).toBe("Suggested next prompt: Same. Press Tab to insert.");
    });

    it("a dismissed prompt stays dismissed while the composer holds attachments, and after they go", () => {
        const ref = createRef<ComposerTiptapEditorRef>();
        const element = (held: boolean) => (
            <ComposerTiptapEditor
                nextPromptHeld={held}
                nextPromptScope="thread-1"
                nextPromptSuggestion="Continue the thread"
                onChange={() => {}}
                onSubmit={() => {}}
                ref={ref}
                value=""
            />
        );
        const view = render(element(false));

        act(() => {
            ref.current!.getEditor()!.commands.clearGhost();
        });
        view.rerender(element(true));
        view.rerender(element(false));

        expect(getGhostCompletion(ref.current!.getEditor()!.state)).toBeNull();
    });

    // The same text for a later reply is placed again once the earlier reply's suggestion has gone: the placement record resets
    // between replies, because the picker answers nothing for a reply while the previous one's cache is shown.
    it("the same prompt for a later reply is placed again once the earlier reply's suggestion has gone", () => {
        const ref = createRef<ComposerTiptapEditorRef>();
        const element = (suggestion: string | null) => (
            <ComposerTiptapEditor nextPromptScope="thread-1" nextPromptSuggestion={suggestion} onChange={() => {}} onSubmit={() => {}} ref={ref} value="" />
        );
        const view = render(element("Same"));

        act(() => {
            ref.current!.getEditor()!.commands.clearGhost();
        });
        view.rerender(element(null));
        view.rerender(element("Same"));

        expect(getGhostCompletion(ref.current!.getEditor()!.state)?.text).toBe("Same");
    });

    it("no suggested prompt is placed while the composer holds attachments", () => {
        const ref = createRef<ComposerTiptapEditorRef>();

        render(
            <ComposerTiptapEditor
                nextPromptHeld
                nextPromptScope="thread-1"
                nextPromptSuggestion="Continue the thread"
                onChange={() => {}}
                onSubmit={() => {}}
                ref={ref}
                value=""
            />,
        );

        expect(getGhostCompletion(ref.current!.getEditor()!.state)).toBeNull();
        expect(announcedText()).toBeNull();
    });

    it("a prompt only hidden by a pause, never dismissed, comes back when the composer is enabled again", () => {
        const ref = createRef<ComposerTiptapEditorRef>();
        const element = (disabled: boolean) => (
            <ComposerTiptapEditor
                disabled={disabled}
                nextPromptScope="thread-1"
                nextPromptSuggestion="Continue the thread"
                onChange={() => {}}
                onSubmit={() => {}}
                ref={ref}
                value=""
            />
        );
        const view = render(element(false));

        expect(getGhostCompletion(ref.current!.getEditor()!.state)?.kind).toBe("prompt");

        view.rerender(element(true));

        expect(getGhostCompletion(ref.current!.getEditor()!.state)).toBeNull();

        view.rerender(element(false));

        expect(getGhostCompletion(ref.current!.getEditor()!.state)?.kind).toBe("prompt");
    });

    it("a dismissed prompt stays dismissed through a pause in which the composer is disabled", () => {
        const ref = createRef<ComposerTiptapEditorRef>();
        const element = (disabled: boolean) => (
            <ComposerTiptapEditor
                disabled={disabled}
                nextPromptScope="thread-1"
                nextPromptSuggestion="Summarize it"
                onChange={() => {}}
                onSubmit={() => {}}
                ref={ref}
                value=""
            />
        );
        const view = render(element(false));

        act(() => {
            ref.current!.getEditor()!.commands.clearGhost();
        });
        view.rerender(element(true));
        view.rerender(element(false));

        expect(getGhostCompletion(ref.current!.getEditor()!.state)).toBeNull();
    });

    // A prompt the person dismisses is gone, so its line goes with it: it is not left to run out on the timer.
    describe("a prompt the person dismisses", () => {
        const mountEditor = (nextPromptSuggestion: string) => {
            const ref = createRef<ComposerTiptapEditorRef>();

            render(
                <ComposerTiptapEditor
                    nextPromptScope="thread-1"
                    nextPromptSuggestion={nextPromptSuggestion}
                    onChange={() => {}}
                    onSubmit={() => {}}
                    ref={ref}
                    value=""
                />,
            );

            return ref;
        };

        it("Escape clears its line at once", () => {
            const editorRef = mountEditor("Summarize it");

            expect(announcedText()).not.toBeNull();

            act(() => {
                editorRef.current!.getEditor()!.commands.clearGhost();
            });

            expect(announcedText()).toBeNull();
        });

        it("typing over it clears its line at once", () => {
            const editorRef = mountEditor("Summarize it");

            act(() => {
                editorRef.current!.getEditor()!.commands.insertContent("x");
            });

            expect(announcedText()).toBeNull();
        });
    });
});
