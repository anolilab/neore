// @vitest-environment jsdom

import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ChatThreadContext } from "@/features/chat/core/context/chat-context-hooks";

import McpAppView from "./mcp-app-view";

const view = vi.hoisted(() => {
    return { props: undefined as { threadId?: string } | undefined };
});

vi.mock("@neore/chat-ui/chat/mcp-app-view", () => {
    return {
        default: (props: { threadId?: string }) => {
            view.props = props;

            return null;
        },
    };
});
vi.mock("@/lib/env", () => {
    return { default: { VITE_LUNORA_URL: "https://lunora.test" } };
});

describe("MCP app view in the web app", () => {
    it("passes the thread of the page it is rendered in, which a prop cannot override", () => {
        const extra = { threadId: "from-elsewhere" } as object;

        render(
            <ChatThreadContext value={{ isNewThread: false, thread: null, threadId: "host-thread" } as never}>
                <McpAppView part={{} as never} resourceUri="ui://x" serverName="srv" toolName="tool" {...extra} />
            </ChatThreadContext>,
        );

        expect(view.props?.threadId).toBe("host-thread");
    });
});
