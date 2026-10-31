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
vi.mock("@tanstack/react-query", () => {
    return {
        useMutation: () => {
            return { isPending: false, mutate: vi.fn() };
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
vi.mock("@/lib/toast", () => {
    return { showError: vi.fn() };
});

const { RateLimitPauseNoticeView } = await import("./rate-limit-pause-notice");

const START = Date.parse("2026-10-31T12:00:00.000Z");

const mount = (overrides: { isRetrying?: boolean; provider?: string; retryInMs?: number } = {}) => {
    const onRetryNow = vi.fn();
    const onStop = vi.fn();

    render(
        <RateLimitPauseNoticeView
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
});
