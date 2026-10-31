// @vitest-environment jsdom

import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
    return {
        props: undefined as Record<string, unknown> | undefined,
        thread: undefined as { userId?: string } | undefined,
        viewer: undefined as string | undefined,
    };
});

vi.mock("@/features/auth/lib/auth-ui-provider", () => {
    return {
        useAuth: () => {
            return {
                hooks: {
                    useSession: () => {
                        return { data: harness.viewer === undefined ? null : { user: { id: harness.viewer } } };
                    },
                },
            };
        },
    };
});

vi.mock("@/features/chat/core/context/chat-context", () => {
    return {
        useChatThread: () => {
            return { thread: harness.thread, threadId: "thread-1" };
        },
    };
});

vi.mock("./host-changes", () => {
    return {
        default: (props: Record<string, unknown>) => {
            harness.props = props;

            return null;
        },
    };
});

const { default: HostChangesOfThread } = await import("./host-changes-of-thread");

const CHANGES = { files: [{ added: 1, path: "a.ts", removed: 0 }], patch: "" };

beforeEach(() => {
    harness.props = undefined;
    harness.thread = { userId: "owner" };
    harness.viewer = "owner";
});

describe("a host turn's changes in a thread", () => {
    it("is commentable for the thread's owner", () => {
        render(<HostChangesOfThread changes={CHANGES} messageId="m1" />);

        expect(harness.props).toMatchObject({ messageId: "m1", threadId: "thread-1" });
    });

    it("is read-only for someone else the thread is shared with", () => {
        harness.viewer = "guest";
        render(<HostChangesOfThread changes={CHANGES} messageId="m1" />);

        expect(harness.props).toBeDefined();
        expect(harness.props).not.toHaveProperty("threadId");
        expect(harness.props).not.toHaveProperty("messageId");
    });

    it("is read-only for a signed-out viewer and for a thread copy that names no owner", () => {
        harness.viewer = undefined;
        render(<HostChangesOfThread changes={CHANGES} messageId="m1" />);
        expect(harness.props).not.toHaveProperty("threadId");

        harness.viewer = "owner";
        harness.thread = {};
        render(<HostChangesOfThread changes={CHANGES} messageId="m1" />);
        expect(harness.props).not.toHaveProperty("threadId");
    });
});
