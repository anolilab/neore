import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen } from "@testing-library/react";
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
            browser: null as { browserId: string; currentUrl?: string; idleUntil: number } | null,
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

/** Renders the card; the query client is returned so a test can make the status read run again. */
const mountCard = (): QueryClient => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(<BrowserLiveView threadId={THREAD} />, {
        wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>,
    });

    return queryClient;
};

const OTHER_URL = "https://live.browser.run/ui/view?mode=tab&second";
const frameSource = (): string | null => screen.queryByTitle(LIVE_VIEW)?.getAttribute("src") ?? null;

/** Whether the page is shown; jsdom's `document.visibilityState` is read-only, so the test sets it. */
const setVisibility = (state: DocumentVisibilityState): void => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: state });
    document.dispatchEvent(new Event("visibilitychange"));
};

afterEach(() => {
    vi.useRealTimers();
    setVisibility("visible");
    backend.browser = null;
    backend.open.mockReset();
});

describe("BrowserLiveView", () => {
    it("shows nothing while no browser runs for the thread", async () => {
        mountCard();

        await act(async () => {
            await Promise.resolve();
        });
        expect(screen.queryByRole("region", { name: "Browser" })).toBeNull();
        expect(screen.queryByTitle(LIVE_VIEW)).toBeNull();
    });

    it("names the page, opens the read-only view on request and drops it on hide", async () => {
        backend.browser = { browserId: "b-1", currentUrl: "https://example.com/login", idleUntil: Date.now() + 60_000 };
        backend.open.mockResolvedValue({ connectBy: Date.now() + 60_000, status: "ok", url: URL });
        mountCard();

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
        backend.browser = { browserId: "b-1", idleUntil: Date.now() + 60_000 };
        backend.open.mockResolvedValue({ status: answer });
        mountCard();

        await userEvent.click(await screen.findByRole("button", { name: "Watch live" }));
        const status = await screen.findByRole("status");

        expect(status.textContent).toBe("The live view is not available right now.");
    });

    it("leaves, taking the open view with it, once the browser sits idle past its reap", async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        backend.browser = { browserId: "b-1", idleUntil: Date.now() + 5000 };
        backend.open.mockResolvedValue({ connectBy: Date.now() + 60_000, status: "ok", url: URL });
        mountCard();

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
        backend.browser = { browserId: "b-1", idleUntil: Date.now() + 60_000 };
        // The answer comes a second later, after the person hid the view again.
        backend.open.mockImplementation(async () => {
            await new Promise((resolve) => {
                setTimeout(resolve, 1000);
            });

            return { connectBy: Date.now() + 60_000, status: "ok", url: URL };
        });
        mountCard();

        await userEvent.click(await screen.findByRole("button", { name: "Watch live" }));
        await userEvent.click(screen.getByRole("button", { name: "Hide live view" }));
        await act(async () => {
            await vi.advanceTimersByTimeAsync(2000);
        });

        expect(screen.queryByTitle(LIVE_VIEW)).toBeNull();
        expect(screen.getByRole("button", { name: "Watch live" }).getAttribute("aria-expanded")).toBe("false");
    });

    it("shows the newest attempt's answer when the person hid and reopened the view, whatever order the answers arrive in", async () => {
        backend.browser = { browserId: "b-1", idleUntil: Date.now() + 60_000 };
        const answers: ((value: unknown) => void)[] = [];

        backend.open.mockImplementation(
            async () =>
                await new Promise((resolve) => {
                    answers.push(resolve);
                }),
        );
        mountCard();

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
        backend.browser = { browserId: "b-1", idleUntil: Date.now() + 60_000 };
        backend.open.mockRejectedValue(error);
        mountCard();

        await userEvent.click(await screen.findByRole("button", { name: "Watch live" }));

        const alert = await screen.findByRole("alert");

        expect(alert.textContent).toBe(message);
    });

    it("asks for a fresh URL instead of framing one whose connect deadline passed while the tab slept", async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        backend.browser = { browserId: "b-1", idleUntil: Date.now() + 600_000 };
        // The first answer arrives after the 60-second connect window (the tab was asleep); the second at once.
        backend.open
            .mockImplementationOnce(async () => {
                await new Promise((resolve) => {
                    setTimeout(resolve, 61_000);
                });

                return { connectBy: Date.now() - 1000, status: "ok", url: URL };
            })
            .mockResolvedValueOnce({ connectBy: Date.now() + 120_000, status: "ok", url: OTHER_URL });
        mountCard();

        await userEvent.click(await screen.findByRole("button", { name: "Watch live" }));
        await act(async () => {
            await vi.advanceTimersByTimeAsync(61_000);
        });
        await act(async () => {
            await vi.advanceTimersByTimeAsync(100);
        });

        expect(backend.open).toHaveBeenCalledTimes(2);
        expect(frameSource()).toBe(OTHER_URL);
    });

    it("renews a view that did not connect in time once the hidden tab is shown, and leaves a connected one alone", async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        backend.browser = { browserId: "b-1", idleUntil: Date.now() + 600_000 };
        backend.open
            .mockResolvedValueOnce({ connectBy: Date.now() + 60_000, status: "ok", url: URL })
            .mockResolvedValueOnce({ connectBy: Date.now() + 120_000, status: "ok", url: OTHER_URL });
        mountCard();

        await userEvent.click(await screen.findByRole("button", { name: "Watch live" }));
        await screen.findByTitle(LIVE_VIEW);
        // Backgrounded: the frame never loaded, and nothing is asked for while no one looks.
        setVisibility("hidden");
        await act(async () => {
            await vi.advanceTimersByTimeAsync(61_000);
        });
        expect(backend.open).toHaveBeenCalledTimes(1);

        await act(async () => {
            setVisibility("visible");
        });
        expect(backend.open).toHaveBeenCalledTimes(2);
        expect(frameSource()).toBe(OTHER_URL);

        // This one connects: its deadline passing ends nothing.
        fireEvent.load(screen.getByTitle(LIVE_VIEW));
        await act(async () => {
            await vi.advanceTimersByTimeAsync(61_000);
        });
        expect(backend.open).toHaveBeenCalledTimes(2);
        expect(frameSource()).toBe(OTHER_URL);
    });

    it("asks for a new URL when the agent's browser is replaced while the view is open", async () => {
        backend.browser = { browserId: "b-1", idleUntil: Date.now() + 600_000 };
        backend.open
            .mockResolvedValueOnce({ connectBy: Date.now() + 60_000, status: "ok", url: URL })
            .mockResolvedValueOnce({ connectBy: Date.now() + 60_000, status: "ok", url: OTHER_URL });
        const queryClient = mountCard();

        await userEvent.click(await screen.findByRole("button", { name: "Watch live" }));
        await screen.findByTitle(LIVE_VIEW);
        expect(frameSource()).toBe(URL);

        backend.browser = { browserId: "b-2", idleUntil: Date.now() + 600_000 };
        await act(async () => {
            await queryClient.invalidateQueries();
        });

        await vi.waitFor(() => {
            expect(frameSource()).toBe(OTHER_URL);
        });
        expect(backend.open).toHaveBeenCalledTimes(2);
    });
});
