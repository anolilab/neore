/**
 * A coding agent's reply on a paired computer says where the computer is with it (plans/acp-agent-host.md §4.6):
 * "Sending" until the computer has received the turn, "Working" only once the agent has started, and nothing
 * that looks like the agent at work before the computer has acknowledged anything. The body is read the way every
 * viewer without a gateway token reads it: the persisted stream, which carries `hostState`.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { UIMessage } from "@/lib/agent";

const harness = vi.hoisted(() => {
    return { body: undefined as Record<string, unknown> | undefined };
});

vi.mock("@lingui/react/macro", () => {
    return {
        Trans: ({ children }: { children: unknown }) => children,
        useLingui: () => {
            return { t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values) };
        },
    };
});

vi.mock("@/lib/lunora/crpc", async () => {
    const { skipToken } = await import("@tanstack/react-query");
    const leaf = {
        queryOptions: (args: unknown) => {
            return { queryFn: args === skipToken ? skipToken : async () => harness.body ?? null, queryKey: ["stream-body", args] };
        },
    };
    const namespace: object = new Proxy({}, { get: (_target, key) => (Object.hasOwn(leaf, key) ? leaf[key as keyof typeof leaf] : namespace) });

    return { useCRPC: () => namespace };
});

vi.mock("@/features/chat/group/speaker-label", () => {
    return { SpeakerChip: () => null };
});

vi.mock("./message-content", () => {
    return { default: ({ message }: { message: UIMessage }) => createElement("div", { "data-testid": "content" }, message.text) };
});

const { StreamingPlaceholder } = await import("./streaming-placeholder");

const mount = (body: Record<string, unknown>) => {
    harness.body = body;

    render(
        <QueryClientProvider client={new QueryClient()}>
            <StreamingPlaceholder streamId="stream-1" />
        </QueryClientProvider>,
    );
};

afterEach(() => {
    harness.body = undefined;
});

describe("a coding agent's turn", () => {
    it("says Sending until the computer has received it, and nothing about working", async () => {
        mount({ hostState: "accepted", reasoning: "", status: "pending", text: "" });

        expect(await screen.findByText("Sending…")).toBeTruthy();
        expect(screen.queryByText("Working…")).toBeNull();
    });

    it("says it is waiting for the agent once received, still not working", async () => {
        mount({ hostState: "received", reasoning: "", status: "pending", text: "" });

        expect(await screen.findByText("Waiting for the agent…")).toBeTruthy();
        expect(screen.queryByText("Working…")).toBeNull();
        expect(screen.queryByText("Sending…")).toBeNull();
    });

    it("says Working only from the agent's first event", async () => {
        mount({ hostState: "running", reasoning: "", status: "streaming", text: "Looking at the tests" });

        expect(await screen.findByText("Working…")).toBeTruthy();
        expect(screen.queryByText("Sending…")).toBeNull();
    });

    it("says none of it once the turn has ended", async () => {
        mount({ hostState: "ended", reasoning: "", status: "error", text: "partial" });

        expect(await screen.findByTestId("content")).toBeTruthy();
        expect(screen.queryByText("Working…")).toBeNull();
        expect(screen.queryByText("Sending…")).toBeNull();
        expect(screen.queryByText("Waiting for the agent…")).toBeNull();
    });
});
