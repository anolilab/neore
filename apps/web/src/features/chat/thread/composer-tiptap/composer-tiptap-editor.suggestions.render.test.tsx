/**
 * The signed-out composer turns suggestions off (`suggestions={false}`): typing "/" or "@" in the REAL editor opens
 * no popup. The popups are what read the account's prompts, skills, files and chats, and they load only once they
 * are handed a match, so no match means no account request. The popups are stood in for to record what they are
 * handed; the editor, its extensions and the match logic are the real ones.
 */
import { act, render, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { ComposerTiptapEditorRef } from "./composer-tiptap-editor";

const handed = vi.hoisted(() => {
    return { file: [] as unknown[], slash: [] as unknown[], variable: [] as unknown[] };
});

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

// The signed-out composer's chrome around the input row; the input row and editor stay real.
vi.mock("@/features/chat/thread/composer", () => {
    return { ComposerModeSwitcher: () => null };
});

vi.mock("@/features/chat/thread/composer-search-mode", () => {
    return { default: () => null };
});

vi.mock("@/features/chat/thread/thread-welcome-suggestions", () => {
    return { default: () => null };
});

vi.mock("@/features/layout/components/sidebar-shortcut", () => {
    return { NAV_LINK_DEFS: [] };
});

vi.mock("./slash-command-popup", () => {
    return {
        default: ({ match }: { match: unknown }) => {
            handed.slash.push(match);

            return null;
        },
    };
});

vi.mock("./file-mention-popup", () => {
    return {
        default: ({ match }: { match: unknown }) => {
            handed.file.push(match);

            return null;
        },
    };
});

vi.mock("./variable-autocomplete-popup", () => {
    return {
        default: ({ match }: { match: unknown }) => {
            handed.variable.push(match);

            return null;
        },
    };
});

const { ComposerTiptapEditor } = await import("./composer-tiptap-editor");
const { SignedOutComposer } = await import("@/features/chat/signed-out/signed-out-chat");

const typeInto = async (ref: React.RefObject<ComposerTiptapEditorRef | null>, text: string) => {
    await waitFor(() => {
        expect(ref.current?.getEditor()).toBeTruthy();
    });
    act(() => {
        ref.current!.getEditor()!.commands.insertContent(text);
    });
};

const opened = (matches: unknown[]) => matches.some((match) => match !== null);

describe("ComposerTiptapEditor suggestions", () => {
    // ProseMirror scrolls the selection into view on every edit; jsdom has no layout for ranges.
    beforeAll(() => {
        const emptyRect = () => new DOMRect();

        Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
        Range.prototype.getBoundingClientRect = emptyRect;
    });

    beforeEach(() => {
        handed.file = [];
        handed.slash = [];
        handed.variable = [];
    });

    it.each(["/", "@", "{{"])("opens a popup for %o when suggestions are on (control)", async (text) => {
        const ref = createRef<ComposerTiptapEditorRef>();

        render(<ComposerTiptapEditor onChange={() => {}} onSubmit={() => {}} ref={ref} value="" />);
        await typeInto(ref, text);

        await waitFor(() => {
            expect(opened(handed.slash) || opened(handed.file) || opened(handed.variable)).toBe(true);
        });
    });

    it.each(["/", "@", "{{"])("opens no popup for %o when suggestions are off", async (text) => {
        const ref = createRef<ComposerTiptapEditorRef>();

        render(<ComposerTiptapEditor onChange={() => {}} onSubmit={() => {}} ref={ref} suggestions={false} value="" />);
        await typeInto(ref, text);
        await act(async () => {
            await new Promise((resolve) => {
                setTimeout(resolve, 50);
            });
        });

        expect(opened(handed.slash) || opened(handed.file) || opened(handed.variable)).toBe(false);
    });

    it.each(["/", "@"])("opens no popup for %o in the signed-out composer", async (text) => {
        const view = render(<SignedOutComposer />);

        // Tiptap hangs its editor on the editable element.
        // eslint-disable-next-line testing-library/no-container, testing-library/no-node-access -- the editor has no role to query by
        const element = view.container.querySelector(".ProseMirror") as
            | (HTMLElement & { editor?: { commands: { insertContent: (value: string) => boolean } } })
            | null;

        await waitFor(() => {
            expect(element?.editor).toBeTruthy();
        });
        act(() => {
            element!.editor!.commands.insertContent(text);
        });
        await act(async () => {
            await new Promise((resolve) => {
                setTimeout(resolve, 50);
            });
        });

        expect(opened(handed.slash) || opened(handed.file) || opened(handed.variable)).toBe(false);
    });
});

describe("ComposerTiptapEditor paste", () => {
    const pasteInto = (element: HTMLElement, text: string) => {
        const event = new Event("paste", { bubbles: true, cancelable: true });

        Object.defineProperty(event, "clipboardData", {
            value: { files: [], getData: (type: string) => (type === "text/plain" ? text : ""), items: [], types: ["text/plain"] },
        });
        act(() => {
            element.dispatchEvent(event);
        });
    };

    it.each([
        ["inserts a paste the composer leaves alone", () => {}, "pasted"],
        ["leaves out a paste the composer took (a long text it attaches)", (event: React.ClipboardEvent) => event.preventDefault(), ""],
    ])("%s", async (_label, onPaste, expected) => {
        const ref = createRef<ComposerTiptapEditorRef>();
        const view = render(<ComposerTiptapEditor onChange={() => {}} onPaste={onPaste} onSubmit={() => {}} ref={ref} value="" />);

        await waitFor(() => {
            expect(ref.current?.getEditor()).toBeTruthy();
        });
        // eslint-disable-next-line testing-library/no-container, testing-library/no-node-access -- the editor has no role to query by
        pasteInto(view.container.querySelector(".ProseMirror") as HTMLElement, "pasted");

        expect(ref.current!.getEditor()!.getText()).toBe(expected);
    });
});
