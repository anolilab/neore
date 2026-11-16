/**
 * The home page's failure path: a failed overview reads as an alert with a
 * retry, and the retry asks for the overview again. A sub-agent waiting on its
 * owner's approval reads as waiting, not running.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
    return { overview: null as unknown, overviewCalls: 0, shouldFail: true };
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

                    return harness.overview;
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
    // A plain anchor, so a row's destination can be read.
    return {
        Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
        useNavigate: () => vi.fn(),
    };
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
    harness.overview = null;
    harness.overviewCalls = 0;
    harness.shouldFail = true;
});

const WAITING_ROW = /Delete the old files/u;
const RUNNING_ROW = /Sort the inbox/u;

describe("home page sub-agents", () => {
    it("shows a sub-agent waiting on its owner's approval as waiting, not running", async () => {
        harness.shouldFail = false;
        harness.overview = {
            approvals: [],
            codingAgents: [],
            dailyBriefEnabled: true,
            notifications: [],
            recentThreads: [],
            reviews: [],
            runningTasks: [],
            subAgents: [
                { _id: "run-1", childThreadId: "child-1", createdAt: 1, parentThreadId: "thread-1", status: "awaiting", task: "Delete the old files" },
                { _id: "run-2", childThreadId: "child-2", createdAt: 2, parentThreadId: "thread-2", status: "running", task: "Sort the inbox" },
            ],
            unreadCount: 0,
        };
        mount();

        const waiting = await screen.findByRole("link", { name: WAITING_ROW });

        expect(screen.getByText("Waiting for your approval")).toBeTruthy();
        // The approval is answered in the sub-agent's own thread; a running one is followed from its parent's.
        expect(waiting.getAttribute("href")).toBe("/chat/child-1");
        expect(screen.getByRole("link", { name: RUNNING_ROW }).getAttribute("href")).toBe("/chat/thread-2");
    });
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
