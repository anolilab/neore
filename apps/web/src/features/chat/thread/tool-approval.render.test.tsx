// @vitest-environment jsdom

import type { ToolPart } from "@neore/chat-ui/types";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import ToolApproval from "./tool-approval";

vi.mock("@lingui/react/macro", () => {
    return {
        useLingui: () => {
            return {
                t: (strings: TemplateStringsArray | string, ...values: unknown[]) => {
                    if (typeof strings === "string") {
                        return strings;
                    }

                    return strings.map((chunk, index) => `${chunk}${String(values[index] ?? "")}`).join("");
                },
            };
        },
    };
});
vi.mock("@tanstack/react-query", () => {
    return {
        useMutation: () => {
            return { isPending: false, mutate: vi.fn() };
        },
    };
});
vi.mock("@/features/auth/lib/auth-ui-provider", () => {
    return {
        useAuth: () => {
            return {
                hooks: {
                    useSession: () => {
                        return { data: { user: { id: "owner" } } };
                    },
                },
            };
        },
    };
});
vi.mock("@/features/chat/core/context/chat-context", () => {
    return {
        useChatThread: () => {
            return { thread: { userId: "owner" }, threadId: "thread-1" };
        },
    };
});
vi.mock("@/lib/lunora/crpc", () => {
    return {
        useCRPC: () => {
            return {
                chat: {
                    tool_permissions: {
                        respondToToolApproval: {
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
vi.mock("@/lib/toast", () => {
    return { showError: vi.fn() };
});

const FOR_AN_HOUR = /for 1 hour/;
const FOR_TODAY = /for today/;
const ALWAYS_ALLOW = /Always allow/;

const part = (type: string): ToolPart => ({ approval: { id: "approval-1" }, input: {}, state: "approval-requested", type }) as unknown as ToolPart;

describe("tool approval card", () => {
    it("offers the time-boxed choices for an ordinary tool", () => {
        render(<ToolApproval part={part("tool-mcp_Files__delete")} />);

        expect(screen.getByRole("button", { name: FOR_AN_HOUR })).toBeTruthy();
        expect(screen.getByRole("button", { name: FOR_TODAY })).toBeTruthy();
    });

    it("offers neither for a device tool, whose call is approved again on the device", () => {
        render(<ToolApproval part={part("tool-device_abc123__fs_read")} />);

        expect(screen.getByRole("button", { name: ALWAYS_ALLOW })).toBeTruthy();
        expect(screen.queryByRole("button", { name: FOR_AN_HOUR })).toBeNull();
        expect(screen.queryByRole("button", { name: FOR_TODAY })).toBeNull();
    });
});
