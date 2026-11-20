// @vitest-environment jsdom

/**
 * "Restore to input" puts a message's text in the composer, from where it goes out as the owner's own words: a guest's note
 * the owner sent on must not offer it, nor one an admin wrote while acting as the owner; a link's draft keeps its mark.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { UIMessage } from "@/lib/agent";

vi.mock("@lingui/react/macro", () => {
    return {
        useLingui: () => {
            return {
                t: (strings: TemplateStringsArray | string, ...values: unknown[]) =>
                    typeof strings === "string" ? strings : String.raw({ raw: strings }, ...values),
            };
        },
    };
});

vi.mock("@/features/chat/core/utils/composer-restore", () => {
    return {
        extractComposerRestorePayload: () => {
            return { files: [], text: "please call me back" };
        },
        requestComposerRestore: vi.fn(),
    };
});

const { default: RestoreToInputAction } = await import("./restore-to-input-action");
const { draftOriginOf, resetDraftOrigins } = await import("@/features/chat/core/utils/draft-origin");

const userMessage = (part: { providerMetadata?: { neore: Record<string, unknown> } }): UIMessage =>
    ({
        id: "m1",
        key: "m1",
        order: 1,
        parts: [{ text: "please call me back", type: "text", ...part }],
        role: "user",
        status: "success",
        text: "please call me back",
    }) as unknown as UIMessage;

describe("RestoreToInputAction", () => {
    it("offers the owner's own message back to the composer", () => {
        render(<RestoreToInputAction message={userMessage({})} />);

        expect(screen.getByRole("button", { name: "Restore to input" })).toBeTruthy();
    });

    it("offers nothing for a guest's note the owner sent on", () => {
        render(<RestoreToInputAction message={userMessage({ providerMetadata: { neore: { guestText: "note-1" } } })} />);

        expect(screen.queryByRole("button", { name: "Restore to input" })).toBeNull();
    });

    it("offers nothing for a message an admin wrote while acting as the owner", () => {
        render(<RestoreToInputAction message={userMessage({ providerMetadata: { neore: { notTyped: { impersonated: true } } } })} />);

        expect(screen.queryByRole("button", { name: "Restore to input" })).toBeNull();
    });

    it("notes a link's draft again when it goes back to the composer, so its next send is marked", () => {
        resetDraftOrigins();
        render(<RestoreToInputAction message={userMessage({ providerMetadata: { neore: { notTyped: { draft: "promptLink" } } } })} />);
        fireEvent.click(screen.getByRole("button", { name: "Restore to input" }));

        expect(draftOriginOf("please call me back")).toBe("promptLink");
    });
});
