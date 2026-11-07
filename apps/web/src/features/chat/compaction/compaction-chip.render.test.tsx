/**
 * The Compact chip is a suggestion made when a thread opens, so it goes once a reply starts in that thread. A local
 * reply still running in another chat is no reply in this one and must not hide it.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import CompactionChip from "./compaction-chip";

const harness = vi.hoisted(() => {
    return { isStreaming: false, isThreadStreaming: false };
});

vi.mock("@lingui/react/macro", () => {
    return {
        useLingui: () => {
            return { t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values) };
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
        useChatIsStreaming: () => {
            return { isStreaming: harness.isStreaming, isThreadStreaming: harness.isThreadStreaming };
        },
        useChatThread: () => {
            return { thread: { userId: "owner" }, threadId: "thread-b" };
        },
    };
});

vi.mock("@/features/chat/core/utils/thread-id", () => {
    return { getValidThreadId: (threadId: string | undefined) => threadId };
});

vi.mock("@/hooks/use-after-first-paint", () => {
    return { default: () => true };
});

// Idle for a day with a context large enough to be worth compacting.
vi.mock("@/lib/lunora/crpc", () => {
    return {
        useCRPC: () => {
            return {
                chat: {
                    compaction: {
                        getCompactionStatus: {
                            queryOptions: () => {
                                return {
                                    queryFn: async () => {
                                        return { canCompact: true, contextTokens: 1_000_000, lastActivityAt: Date.now() - 24 * 60 * 60 * 1000 };
                                    },
                                    queryKey: ["compaction-status"],
                                };
                            },
                        },
                    },
                },
            };
        },
    };
});

vi.mock("./use-compact-thread", () => {
    return {
        default: () => {
            return { compact: vi.fn(), isCompacting: false };
        },
    };
});

const renderChip = () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;

    return render(<CompactionChip />, { wrapper });
};

afterEach(() => {
    harness.isStreaming = false;
    harness.isThreadStreaming = false;
});

describe("the Compact chip", () => {
    it("stays while a local reply runs in another chat", async () => {
        expect.assertions(1);

        harness.isStreaming = true;
        renderChip();

        await expect(screen.findByRole("button", { name: "Compact the conversation before the next prompt" })).resolves.toBeDefined();
    });

    it("goes once a reply starts in this chat", async () => {
        expect.assertions(1);

        harness.isStreaming = true;
        harness.isThreadStreaming = true;
        renderChip();

        // Give the status query time to answer, so the chip would show if nothing hid it.
        await new Promise((resolve) => {
            setTimeout(resolve, 50);
        });

        expect(screen.queryByRole("button", { name: "Compact the conversation before the next prompt" })).toBeNull();
    });
});
