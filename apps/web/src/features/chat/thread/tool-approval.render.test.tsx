// @vitest-environment jsdom

import type { ToolPart } from "@neore/chat-ui/types";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import ToolApproval from "./tool-approval";

vi.mock("@lingui/react/macro", () => {
    return {
        Plural: ({ other, value }: { other: string; value: number }) => `${String(value)}${other.slice(1)}`,
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
const { viewer } = vi.hoisted(() => {
    return { viewer: { id: "owner" } };
});

vi.mock("@/features/auth/hooks/use-auth-session", () => {
    return {
        useAuthSession: () => {
            return { data: { user: viewer } };
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

const part = (type: string, input: unknown = {}): ToolPart =>
    ({ approval: { id: "approval-1" }, input, state: "approval-requested", type }) as unknown as ToolPart;

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

    it("lists the memories a forget confirm deletes, and offers only Approve and Deny", () => {
        render(<ToolApproval part={part("tool-forget", { memories: [{ id: "m1", text: "User lives in Berlin" }] })} />);

        expect(screen.getByRole("list", { name: "Memories to forget" }).textContent).toContain("User lives in Berlin");
        expect(screen.getByRole("button", { name: "Approve forget once" })).toBeTruthy();
        expect(screen.getByRole("button", { name: "Deny forget" })).toBeTruthy();
        expect(screen.queryByRole("button", { name: ALWAYS_ALLOW })).toBeNull();
        expect(screen.queryByRole("button", { name: FOR_AN_HOUR })).toBeNull();
    });

    it("shows an id named twice once, and two memories with the same text as two rows, with no key warning", () => {
        const warn = vi.spyOn(console, "error").mockImplementation(() => undefined);

        try {
            render(
                <ToolApproval
                    part={part("tool-forget", {
                        memories: [
                            { id: "m1", text: "User lives in Berlin" },
                            { id: "m1", text: "User lives in Berlin" },
                            { id: "m2", text: "User likes tea" },
                            { id: "m3", text: "User likes tea" },
                        ],
                    })}
                />,
            );

            const rows = within(screen.getByRole("list", { name: "Memories to forget" })).getAllByRole("listitem");

            expect(rows.map((row) => row.textContent)).toStrictEqual(["User lives in Berlin", "User likes tea", "User likes tea"]);
            expect(warn.mock.calls.flat().join(" ")).not.toContain("same key");
        } finally {
            warn.mockRestore();
        }
    });

    it("shows a viewer who is not the owner how many memories wait, never what they say", () => {
        viewer.id = "guest";

        try {
            render(<ToolApproval part={part("tool-forget", { memories: [{ id: "m1", text: "User lives in Berlin" }] })} />);

            expect(screen.queryByText("User lives in Berlin")).toBeNull();
            expect(document.body.textContent).not.toContain("Berlin");
            expect(screen.getByText("1 memories are waiting for the chat owner to confirm.")).toBeTruthy();
            expect(screen.queryByRole("button", { name: "Approve forget once" })).toBeNull();
        } finally {
            viewer.id = "owner";
        }
    });

    it("shows a forget lookup that asks as any other call, with its time-boxed choices", () => {
        render(<ToolApproval part={part("tool-forget", { query: "User lives in Berlin" })} />);

        expect(screen.queryByRole("list", { name: "Memories to forget" })).toBeNull();
        expect(screen.getByRole("button", { name: ALWAYS_ALLOW })).toBeTruthy();
        expect(screen.getByRole("button", { name: FOR_AN_HOUR })).toBeTruthy();
    });
});
