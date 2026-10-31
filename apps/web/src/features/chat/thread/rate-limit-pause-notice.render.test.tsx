// @vitest-environment jsdom

import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => {
    return {
        Trans: ({ children }: { children: unknown }) => children,
        useLingui: () => {
            return { t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values) };
        },
    };
});
const { access, queueStore } = vi.hoisted(() => {
    return { access: { permission: undefined as "admin" | "read" | "write" | undefined }, queueStore: { setPaused: vi.fn() } };
});

vi.mock("@tanstack/react-query", () => {
    return {
        skipToken: Symbol("skipToken"),
        useMutation: () => {
            return { isPending: false, mutate: vi.fn() };
        },
        useQuery: () => {
            return { data: access.permission ? { permission: access.permission } : undefined };
        },
    };
});
vi.mock("@/lib/lunora/crpc", () => {
    return {
        useCRPC: () => {
            return {
                chat: {
                    functions: {
                        abortThreadStream: {
                            mutationOptions: () => {
                                return {};
                            },
                        },
                    },
                    sharing: {
                        getThreadAccess: {
                            queryOptions: () => {
                                return {};
                            },
                        },
                    },
                    rate_limit_retry: {
                        retryRateLimitedRun: {
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
vi.mock("@/features/chat/core/stores/prompt-queue-store", () => {
    return { usePromptQueueStore: { getState: () => queueStore } };
});
vi.mock("@/lib/toast", () => {
    return { showError: vi.fn() };
});

const { OVERDUE_MS, RateLimitPauseNotice, RateLimitPauseNoticeView } = await import("./rate-limit-pause-notice");

const START = Date.parse("2026-10-31T12:00:00.000Z");

const mount = (overrides: { canControl?: boolean; isRetrying?: boolean; provider?: string; retryInMs?: number } = {}) => {
    const onRetryNow = vi.fn();
    const onStop = vi.fn();

    render(
        <RateLimitPauseNoticeView
            canControl={overrides.canControl ?? true}
            isRetrying={overrides.isRetrying ?? false}
            isStopping={false}
            onRetryNow={onRetryNow}
            onStop={onStop}
            pause={{
                provider: "provider" in overrides ? overrides.provider : "anthropic",
                reason: "rate_limit",
                retryAt: START + (overrides.retryInMs ?? 42_000),
                status: 429,
            }}
        />,
    );

    return { onRetryNow, onStop };
};

const tick = (ms: number) => {
    act(() => {
        vi.advanceTimersByTime(ms);
    });
};

describe("rate limit pause notice", () => {
    beforeEach(() => {
        vi.useFakeTimers({ now: START });
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("says who limited the run and counts down to the retry time", () => {
        mount();

        expect(screen.getByText("Rate limited by Anthropic, retrying in 0:42")).toBeTruthy();

        tick(1000);
        expect(screen.getByText("Rate limited by Anthropic, retrying in 0:41")).toBeTruthy();

        tick(40_000);
        expect(screen.getByText("Rate limited by Anthropic, retrying in 0:01")).toBeTruthy();
    });

    it("drops the provider when the gateway named none", () => {
        mount({ provider: undefined });

        expect(screen.getByText("Rate limited, retrying in 0:42")).toBeTruthy();
    });

    it("keeps the ticking countdown away from screen readers and speaks in a polite status region at coarse steps", () => {
        mount();

        const visible = screen.getByText("Rate limited by Anthropic, retrying in 0:42");
        const status = screen.getByRole("status");

        expect(visible.getAttribute("aria-hidden")).toBe("true");
        expect(status.getAttribute("aria-live")).toBe("polite");
        expect(status.textContent).toBe("Rate limited by Anthropic. Retrying in about 1:00");

        // Eleven seconds of ticks: the visible text moved every second, the spoken text did not.
        tick(11_000);
        expect(screen.getByText("Rate limited by Anthropic, retrying in 0:31")).toBeTruthy();
        expect(status.textContent).toBe("Rate limited by Anthropic. Retrying in about 1:00");

        // Past the half-minute line it moves once.
        tick(2000);
        expect(status.textContent).toBe("Rate limited by Anthropic. Retrying in about 0:30");
    });

    it("says it is retrying once the wait is over, and stops offering to end it", () => {
        mount({ retryInMs: 3000 });

        tick(3000);

        expect(screen.getByRole("status").textContent).toBe("Retrying now");
        expect(screen.getByText("Retrying now", { selector: "p" })).toBeTruthy();
        expect((screen.getByRole("button", { name: "Retry now" }) as HTMLButtonElement).disabled).toBe(true);
    });

    it("offers Retry now again when the resume that was queued is long overdue", () => {
        mount({ retryInMs: 3000 });

        tick(3000 + OVERDUE_MS - 1000);
        expect((screen.getByRole("button", { name: "Retry now" }) as HTMLButtonElement).disabled).toBe(true);

        tick(1000);
        expect(screen.getByRole("status").textContent).toBe("The retry is taking longer than expected");
        expect((screen.getByRole("button", { name: "Retry now" }) as HTMLButtonElement).disabled).toBe(false);
    });

    it("shows the countdown to a viewer without write access, and no buttons", () => {
        mount({ canControl: false });

        expect(screen.getByText("Rate limited by Anthropic, retrying in 0:42")).toBeTruthy();
        expect(screen.queryByRole("button", { name: "Retry now" })).toBeNull();
        expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    });

    it("Retry now and Stop each call back once", () => {
        const { onRetryNow, onStop } = mount();

        fireEvent.click(screen.getByRole("button", { name: "Retry now" }));
        expect(onRetryNow).toHaveBeenCalledOnce();
        expect(onStop).not.toHaveBeenCalled();

        fireEvent.click(screen.getByRole("button", { name: "Stop" }));
        expect(onStop).toHaveBeenCalledOnce();
    });

    it("disables Retry now while the request is in flight", () => {
        mount({ isRetrying: true });

        expect((screen.getByRole("button", { name: "Retry now" }) as HTMLButtonElement).disabled).toBe(true);
    });

    describe("wired to the thread", () => {
        const wired = () => {
            render(<RateLimitPauseNotice pause={{ reason: "rate_limit", retryAt: START + 42_000, status: 429 }} threadId="t1" />);
        };

        it.each(["write", "admin"] as const)("gives a %s collaborator Retry now and Stop", (permission) => {
            access.permission = permission;
            wired();

            expect(screen.getByRole("button", { name: "Retry now" })).toBeTruthy();
            expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
        });

        it("Stop keeps the queued prompts from auto-sending, as the composer's Stop does", () => {
            access.permission = "write";
            wired();

            fireEvent.click(screen.getByRole("button", { name: "Stop" }));

            expect(queueStore.setPaused).toHaveBeenCalledWith("t1", true);
        });

        it("gives a read-only collaborator the countdown only", () => {
            access.permission = "read";
            wired();

            expect(screen.getByText("Rate limited, retrying in 0:42")).toBeTruthy();
            expect(screen.queryByRole("button")).toBeNull();
        });

        it("shows no buttons until the viewer's permission is known", () => {
            access.permission = undefined;
            wired();

            expect(screen.queryByRole("button")).toBeNull();
        });
    });
});
