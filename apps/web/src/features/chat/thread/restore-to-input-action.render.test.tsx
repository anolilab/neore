// @vitest-environment jsdom

/**
 * "Restore to input" puts a message's text in the composer, from where it goes out as the owner's own words: a guest's note
 * the owner sent on must not offer it; text the owner did not type (a link's draft, an admin's message) keeps its mark.
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

vi.mock("@/features/auth/hooks/use-auth-session", () => {
    return {
        useAuthSession: () => {
            return { data: { user: { id: "owner-1" } } };
        },
    };
});

const { default: RestoreToInputAction } = await import("./restore-to-input-action");
const { requestComposerRestore } = await import("@/features/chat/core/utils/composer-restore");

const userMessage = (part: { providerMetadata?: { neore: Record<string, unknown> } }, userId?: string): UIMessage =>
    ({
        ...(userId !== undefined && { userId }),
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

    it("sends a message an admin wrote while acting as the owner back marked, so the owner's send of it is not their own", () => {
        render(<RestoreToInputAction message={userMessage({ providerMetadata: { neore: { notTyped: { impersonated: true } } } })} />);
        fireEvent.click(screen.getByRole("button", { name: "Restore to input" }));

        expect(requestComposerRestore).toHaveBeenLastCalledWith({ draftFrom: "impersonated", files: [], text: "please call me back" });
    });

    it("sends a link's draft back to the composer with its mark, so its next send is marked", () => {
        render(<RestoreToInputAction message={userMessage({ providerMetadata: { neore: { notTyped: { draft: "promptLink" } } } })} />);
        fireEvent.click(screen.getByRole("button", { name: "Restore to input" }));

        expect(requestComposerRestore).toHaveBeenLastCalledWith({ draftFrom: "promptLink", files: [], text: "please call me back" });
    });

    it("sends a collaborator's message in a shared chat back marked, so the viewer's send of it is not their own", () => {
        render(<RestoreToInputAction message={userMessage({}, "collaborator-1")} />);
        fireEvent.click(screen.getByRole("button", { name: "Restore to input" }));

        expect(requestComposerRestore).toHaveBeenLastCalledWith({ draftFrom: "collaborator", files: [], text: "please call me back" });
    });

    it("keeps a stronger mark on a collaborator's message an admin wrote", () => {
        render(<RestoreToInputAction message={userMessage({ providerMetadata: { neore: { notTyped: { impersonated: true } } } }, "collaborator-1")} />);
        fireEvent.click(screen.getByRole("button", { name: "Restore to input" }));

        expect(requestComposerRestore).toHaveBeenLastCalledWith({ draftFrom: "impersonated", files: [], text: "please call me back" });
    });

    it("sends the viewer's own saved message back unmarked", () => {
        render(<RestoreToInputAction message={userMessage({}, "owner-1")} />);
        fireEvent.click(screen.getByRole("button", { name: "Restore to input" }));

        expect(requestComposerRestore).toHaveBeenLastCalledWith({ files: [], text: "please call me back" });
    });

    it("sends the owner's own message back unmarked", () => {
        render(<RestoreToInputAction message={userMessage({})} />);
        fireEvent.click(screen.getByRole("button", { name: "Restore to input" }));

        expect(requestComposerRestore).toHaveBeenLastCalledWith({ files: [], text: "please call me back" });
    });
});
