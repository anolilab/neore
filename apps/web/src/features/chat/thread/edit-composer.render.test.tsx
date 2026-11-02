// @vitest-environment jsdom

import { MAX_PROMPT_CHARS } from "@neore/ai/constants";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import EditComposer from "./edit-composer";

vi.mock("@lingui/react/macro", () => {
    return {
        useLingui: () => {
            return {
                i18n: { locale: "en" },
                t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values),
            };
        },
    };
});
vi.mock("@/features/chat/core/context/chat-context", () => {
    return {
        useChatActions: () => {
            return { editMessage: vi.fn() };
        },
        useChatThread: () => {
            return { threadId: "t1" };
        },
    };
});
vi.mock("@/features/chat/core/hooks/use-validated-thread", () => {
    return { isValidThreadId: () => true };
});
vi.mock("@/features/chat/core/stores/chat-ui-store", () => {
    return { useChatUIStore: (select: (state: { stopEditing: () => void }) => unknown) => select({ stopEditing: () => {} }) };
});
vi.mock("@/lib/lunora/crpc", () => {
    return {
        useCRPC: () => {
            return {
                agent: {
                    branches: {
                        editAssistantReply: {
                            mutationOptions: () => {
                                return {};
                            },
                        },
                    },
                },
            };
        },
    };
});
vi.mock("@tanstack/react-query", () => {
    return {
        useMutation: () => {
            return { isPending: false, mutateAsync: vi.fn() };
        },
    };
});
vi.mock("@/lib/toast", () => {
    return { showError: vi.fn() };
});

const long = "x".repeat(MAX_PROMPT_CHARS + 1);
const messageOf = (role: "assistant" | "user") => ({ id: "m1", role, text: long }) as never;

describe("EditComposer length cap", () => {
    it("blocks saving a user message over the cap and links the notice to the field", () => {
        render(<EditComposer message={messageOf("user")} />);

        const field = screen.getByRole("textbox");

        expect(field.getAttribute("aria-invalid")).toBe("true");
        expect(field.getAttribute("aria-describedby")).toBe(screen.getByRole("alert").id);
        expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    });

    it("leaves the field valid under the cap", () => {
        render(<EditComposer message={messageOf("user")} />);

        const field = screen.getByRole("textbox");

        fireEvent.change(field, { target: { value: "short" } });

        expect(field.getAttribute("aria-invalid")).toBe("false");
        expect(field.getAttribute("aria-describedby")).toBeNull();
    });

    it("lets a long assistant reply be saved", () => {
        render(<EditComposer message={messageOf("assistant")} />);

        expect(screen.queryByRole("alert")).toBeNull();
        expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(false);
    });
});
