/**
 * A recalled prompt replaces the draft, so the draft's not-typed mark becomes the recalled message's: one the server saved
 * marked goes out marked again, and walking back down brings the draft's own mark back.
 */
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useChatUIStore } from "@/features/chat/core/stores/chat-ui-store";

vi.mock("@/features/chat/core/context/chat-context", () => {
    return {
        useChatMessages: () => {
            return { messages: [] };
        },
    };
});

const { usePromptHistory } = await import("./use-prompt-history");

/** The composer's part: the editor writes the step's text, then reports the change. */
const show = (history: ReturnType<typeof usePromptHistory>, text: string | null): void => {
    useChatUIStore.getState().setComposerText(text ?? "");
    history.onTextChange(text ?? "");
};

beforeEach(() => {
    useChatUIStore.getState().reset();
});

describe("usePromptHistory not-typed mark", () => {
    it("marks a recalled prompt the server saved marked, and gives the draft its own mark back on the way down", () => {
        const { result } = renderHook(() => usePromptHistory(() => useChatUIStore.getState().composerText));

        result.current.setEntries(["mine", "Sign in to my bank"], new Map([["Sign in to my bank", "promptLink"]]));
        useChatUIStore.getState().setComposerText("half a draft from a share");
        useChatUIStore.getState().setComposerDraftFrom("shellLink");

        show(result.current, result.current.navigate("up"));

        expect(useChatUIStore.getState()).toMatchObject({ composerDraftFrom: undefined, composerText: "mine" });

        show(result.current, result.current.navigate("up"));

        expect(useChatUIStore.getState()).toMatchObject({ composerDraftFrom: "promptLink", composerText: "Sign in to my bank" });

        show(result.current, result.current.navigate("down"));
        show(result.current, result.current.navigate("down"));

        expect(useChatUIStore.getState()).toMatchObject({ composerDraftFrom: "shellLink", composerText: "half a draft from a share" });
    });
});
