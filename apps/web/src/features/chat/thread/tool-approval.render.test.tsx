// @vitest-environment jsdom

import type { ToolPart } from "@neore/chat-ui/types";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import ToolApproval from "./tool-approval";

vi.mock("@lingui/react/macro", () => {
    return {
        useLingui: () => {
            return {
                t: (strings: TemplateStringsArray | string, ...values: unknown[]) =>
                    typeof strings === "string" ? strings : strings.reduce((out, chunk, index) => `${out}${chunk}${String(values[index] ?? "")}`, ""),
            };
        },
    };
});
vi.mock("@tanstack/react-query", () => {
    return { useMutation: () => ({ isPending: false, mutate: vi.fn() }) };
});
vi.mock("@/features/auth/lib/auth-ui-provider", () => {
    return { useAuth: () => ({ hooks: { useSession: () => ({ data: { user: { id: "owner" } } }) } }) };
});
vi.mock("@/features/chat/core/context/chat-context", () => {
    return { useChatThread: () => ({ thread: { userId: "owner" }, threadId: "thread-1" }) };
});
vi.mock("@/lib/lunora/crpc", () => {
    return { useCRPC: () => ({ chat: { tool_permissions: { respondToToolApproval: { mutationOptions: () => ({}) } } } }) };
});
vi.mock("@/lib/toast", () => {
    return { showError: vi.fn() };
});

const part = (type: string): ToolPart => ({ approval: { id: "approval-1" }, input: {}, state: "approval-requested", type }) as unknown as ToolPart;

describe("tool approval card", () => {
    it("offers the time-boxed choices for an ordinary tool", () => {
        render(<ToolApproval part={part("tool-mcp_Files__delete")} />);

        expect(screen.getByRole("button", { name: /for 1 hour/ })).toBeTruthy();
        expect(screen.getByRole("button", { name: /for today/ })).toBeTruthy();
    });

    it("offers neither for a device tool, whose call is approved again on the device", () => {
        render(<ToolApproval part={part("tool-device_abc123__fs_read")} />);

        expect(screen.getByRole("button", { name: /Always allow/ })).toBeTruthy();
        expect(screen.queryByRole("button", { name: /for 1 hour/ })).toBeNull();
        expect(screen.queryByRole("button", { name: /for today/ })).toBeNull();
    });
});
