import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import BrowserLiveView from "./browser-live-view";

// The unit-test transform does not compile Lingui macros (vi.mock is hoisted).
vi.mock("@lingui/react/macro", () => {
    return {
        useLingui: () => {
            return { t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values) };
        },
    };
});

const { backend } = vi.hoisted(() => {
    return {
        backend: {
            browser: null as { currentUrl?: string; idleUntil: number } | null,
            open: vi.fn(),
        },
    };
});

vi.mock("@/lib/lunora/crpc", () => {
    return {
        useAction: () => backend.open,
        useCRPC: () => {
            return {
                browser: {
                    live_view: {
                        getThreadBrowser: {
                            queryOptions: (args: unknown) => {
                                return { queryFn: async () => backend.browser, queryKey: ["browser", args] };
                            },
                        },
                    },
                },
            };
        },
    };
});

const THREAD = "thread-1" as never;
const URL = "https://live.browser.run/ui/view?mode=tab";
const LIVE_VIEW = /Live view/u;

const renderCard = () =>
    render(<BrowserLiveView threadId={THREAD} />, {
        wrapper: ({ children }: { children: ReactNode }) => (
            <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{children}</QueryClientProvider>
        ),
    });

afterEach(() => {
    vi.useRealTimers();
    backend.browser = null;
    backend.open.mockReset();
});

describe("BrowserLiveView", () => {
    it("shows nothing while no browser runs for the thread", async () => {
        renderCard();

        await act(async () => {
            await Promise.resolve();
        });
        expect(screen.queryByRole("region", { name: "Browser" })).toBeNull();
        expect(screen.queryByTitle(LIVE_VIEW)).toBeNull();
    });

    it("names the page, opens the read-only view on request and drops it on hide", async () => {
        backend.browser = { currentUrl: "https://example.com/login", idleUntil: Date.now() + 60_000 };
        backend.open.mockResolvedValue({ connectBy: Date.now() + 60_000, status: "ok", url: URL });
        renderCard();

        const region = await screen.findByRole("region", { name: "Browser" });

        expect(region.textContent).toContain("https://example.com/login");
        expect(screen.queryByTitle(LIVE_VIEW)).toBeNull();
        // The URL is a credential: it is asked for only when the person opens the view.
        expect(backend.open).not.toHaveBeenCalled();

        const toggle = screen.getByRole("button", { name: "Watch live" });

        await userEvent.click(toggle);
        const frame = await screen.findByTitle("Live view of the agent's browser (read-only)");

        expect(frame.getAttribute("src")).toBe(URL);
        expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
        expect(screen.getByRole("button", { name: "Hide live view" }).getAttribute("aria-expanded")).toBe("true");

        await userEvent.click(screen.getByRole("button", { name: "Hide live view" }));
        expect(screen.queryByTitle(LIVE_VIEW)).toBeNull();
    });

    it.each(["unavailable", "ended"])("says the view is unavailable when the answer is %s", async (answer) => {
        backend.browser = { idleUntil: Date.now() + 60_000 };
        backend.open.mockResolvedValue({ status: answer });
        renderCard();

        await userEvent.click(await screen.findByRole("button", { name: "Watch live" }));
        const status = await screen.findByRole("status");

        expect(status.textContent).toBe("The live view is not available right now.");
    });

    it("leaves, taking the open view with it, once the browser sits idle past its reap", async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        backend.browser = { idleUntil: Date.now() + 5000 };
        backend.open.mockResolvedValue({ connectBy: Date.now() + 60_000, status: "ok", url: URL });
        renderCard();

        await userEvent.click(await screen.findByRole("button", { name: "Watch live" }));
        await screen.findByTitle(LIVE_VIEW);

        await act(async () => {
            await vi.advanceTimersByTimeAsync(6000);
        });
        expect(screen.queryByRole("region", { name: "Browser" })).toBeNull();
        expect(screen.queryByTitle(LIVE_VIEW)).toBeNull();
    });

    it("drops a view that arrives after the person hid it again", async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        backend.browser = { idleUntil: Date.now() + 60_000 };
        // The answer comes a second later, after the person hid the view again.
        backend.open.mockImplementation(async () => {
            await new Promise((resolve) => {
                setTimeout(resolve, 1000);
            });

            return { connectBy: Date.now() + 60_000, status: "ok", url: URL };
        });
        renderCard();

        await userEvent.click(await screen.findByRole("button", { name: "Watch live" }));
        await userEvent.click(screen.getByRole("button", { name: "Hide live view" }));
        await act(async () => {
            await vi.advanceTimersByTimeAsync(2000);
        });

        expect(screen.queryByTitle(LIVE_VIEW)).toBeNull();
        expect(screen.getByRole("button", { name: "Watch live" }).getAttribute("aria-expanded")).toBe("false");
    });

    it("shows the newest attempt's answer when the person hid and reopened the view, whatever order the answers arrive in", async () => {
        backend.browser = { idleUntil: Date.now() + 60_000 };
        const answers: ((value: unknown) => void)[] = [];

        backend.open.mockImplementation(
            async () =>
                await new Promise((resolve) => {
                    answers.push(resolve);
                }),
        );
        renderCard();

        await userEvent.click(await screen.findByRole("button", { name: "Watch live" }));
        await userEvent.click(screen.getByRole("button", { name: "Hide live view" }));
        await userEvent.click(screen.getByRole("button", { name: "Watch live" }));

        // The older attempt answers first, while the newer one is still opening: it must not fill the view.
        await act(async () => {
            answers[0]?.({ status: "unavailable" });
        });
        expect(screen.getByRole("status").textContent).toBe("Opening the live view…");

        await act(async () => {
            answers[1]?.({ connectBy: Date.now() + 60_000, status: "ok", url: URL });
        });

        expect(screen.getByTitle(LIVE_VIEW).getAttribute("src")).toBe(URL);
        expect(screen.queryByText("The live view is not available right now.")).toBeNull();
    });

    it.each([
        [{ code: "TOO_MANY_REQUESTS" }, "Too many live views were opened. Try again later."],
        [new Error("network"), "The live view could not be opened. Try again."],
    ])("shows a failed request as an error, not as an unavailable view (%o)", async (error, message) => {
        backend.browser = { idleUntil: Date.now() + 60_000 };
        backend.open.mockRejectedValue(error);
        renderCard();

        await userEvent.click(await screen.findByRole("button", { name: "Watch live" }));

        const alert = await screen.findByRole("alert");

        expect(alert.textContent).toBe(message);
    });
});
