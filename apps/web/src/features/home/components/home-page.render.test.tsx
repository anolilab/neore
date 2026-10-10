/**
 * The home page's failure path: a failed overview reads as an alert with a
 * retry, and the retry asks for the overview again.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
    return { overviewCalls: 0, shouldFail: true };
});

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

vi.mock("@/lib/lunora/crpc", () => {
    const overview = {
        queryOptions: () => {
            return {
                queryFn: async () => {
                    harness.overviewCalls += 1;

                    if (harness.shouldFail) {
                        throw new Error("backend down");
                    }

                    return null;
                },
                queryKey: ["home-overview"],
            };
        },
    };
    const mutation = {
        mutationOptions: () => {
            return { mutationFn: async () => null };
        },
    };

    return {
        useCRPC: () => {
            return { home: { overview: { getHomeOverview: overview } }, notifications: { daily_brief: { setDailyBriefEnabled: mutation } } };
        },
    };
});

vi.mock("@tanstack/react-router", () => {
    return { Link: ({ children }: { children: unknown }) => children, useNavigate: () => vi.fn() };
});

vi.mock("@/features/notifications/hooks/use-notification-inbox", () => {
    return {
        default: () => {
            return { markRead: vi.fn() };
        },
    };
});

vi.mock("@/features/notifications/components/notification-list", () => {
    return { default: () => null };
});

const { default: HomePage } = await import("./home-page");

const mount = () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    return render(createElement(QueryClientProvider, { client: queryClient }, createElement(HomePage)));
};

afterEach(() => {
    harness.overviewCalls = 0;
    harness.shouldFail = true;
});

describe("home page error state", () => {
    it("announces a failed overview as an alert", async () => {
        mount();

        const alert = await screen.findByRole("alert");

        expect(alert.textContent).toContain("Your overview could not be loaded.");
    });

    it("asks for the overview again on retry", async () => {
        mount();

        await screen.findByRole("alert");

        expect(harness.overviewCalls).toBe(1);

        harness.shouldFail = false;
        fireEvent.click(screen.getByRole("button", { name: "Try again" }));

        await waitFor(() => {
            expect(harness.overviewCalls).toBe(2);
        });
        await waitFor(() => {
            expect(screen.queryByRole("alert")).toBeNull();
        });
    });
});
