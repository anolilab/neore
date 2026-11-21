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
            browser: null as {
                accessUntil?: number;
                browserId: string;
                control?: { byYou: boolean; until: number };
                currentUrl?: string;
                idleUntil: number;
                /** The server's clock at the answer; this device's when left out. */
                now?: number;
            } | null,
            /** When set, the status read fails with it. */
            statusError: undefined as Error | undefined,
            open: vi.fn(),
            /** How often the status was read. */
            statusReads: 0,
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
                                return {
                                    queryFn: async () => {
                                        backend.statusReads += 1;

                                        if (backend.statusError !== undefined) {
                                            throw backend.statusError;
                                        }

                                        return backend.browser && { now: Date.now(), ...backend.browser };
                                    },
                                    queryKey: ["browser", args],
                                };
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
    // Spies on the clock first (a test's `setTimeout` wraps the fake one), then the real clock back.
    vi.restoreAllMocks();
    vi.useRealTimers();
    setVisibility("visible");
    backend.browser = null;
    backend.statusError = undefined;
    backend.statusReads = 0;
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

    it("leaves with the open view once a reader's grant ends, and asks the status again", async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        backend.browser = { accessUntil: Date.now() + 5000, browserId: "b-1", currentUrl: "https://example.com/login", idleUntil: Date.now() + 60_000 };
        backend.open.mockResolvedValue({ connectBy: Date.now() + 60_000, status: "ok", url: URL });
        mountCard();

        await userEvent.click(await screen.findByRole("button", { name: "Watch live" }));
        await screen.findByTitle(LIVE_VIEW);
        const readsBefore = backend.statusReads;

        // Past the grant's end the server answers nothing.
        backend.browser = null;
        await act(async () => {
            await vi.advanceTimersByTimeAsync(6000);
        });
        expect(screen.queryByRole("region", { name: "Browser" })).toBeNull();
        expect(screen.queryByText("https://example.com/login")).toBeNull();
        expect(backend.statusReads).toBeGreaterThan(readsBefore);
    });

    it("stays gone once a reader's grant ends, though asking again answers the same last push", async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        const pushedAt = Date.now();

        // A live query's refetch answers the subscription's last push: the same answer, with the same server clock.
        backend.browser = { accessUntil: pushedAt + 10_000, browserId: "b-1", idleUntil: pushedAt + 600_000, now: pushedAt };
        mountCard();
        await screen.findByRole("region", { name: "Browser" });

        await act(async () => {
            await vi.advanceTimersByTimeAsync(10_100);
        });
        expect(screen.queryByRole("region", { name: "Browser" })).toBeNull();

        // The card asked again: its later receipt time never moves the grant's end back into the future.
        for (const step of [1000, 5000, 30_000]) {
            await act(async () => {
                await vi.advanceTimersByTimeAsync(step);
            });
            expect(screen.queryByRole("region", { name: "Browser" })).toBeNull();
        }

        expect(backend.statusReads).toBeGreaterThan(1);
    });

    it("waits for a grant that ends weeks from now without waking up again and again, and leaves when it ends", async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        const DAY = 24 * 60 * 60 * 1000;

        const fakeSetTimeout = globalThis.setTimeout;
        // A browser fires a timer longer than 2^31 − 1 ms at once; the fake clock does not, so the test does what a browser does.
        const timers = vi
            .spyOn(globalThis, "setTimeout")
            .mockImplementation(((handler: () => void, delay?: number) =>
                fakeSetTimeout(handler, (delay ?? 0) > 2_147_483_647 ? 1 : delay)) as typeof setTimeout);

        backend.browser = { accessUntil: Date.now() + 30 * DAY, browserId: "b-1", idleUntil: Date.now() + 60 * DAY };
        mountCard();
        await screen.findByRole("region", { name: "Browser" });
        timers.mockClear();

        // A second in steps, each committed on its own (one `act` would batch the renders of a looping card into one).
        for (let step = 0; step < 20; step += 1) {
            await act(async () => {
                await vi.advanceTimersByTimeAsync(50);
            });
        }

        // A card that set a new timer on every render would have set one for each step.
        expect(timers.mock.calls.length).toBeLessThan(5);
        expect(screen.getByRole("region", { name: "Browser" })).toBeTruthy();

        backend.browser = null;
        await act(async () => {
            await vi.advanceTimersByTimeAsync(29 * DAY);
        });
        expect(screen.getByRole("region", { name: "Browser" })).toBeTruthy();
        await act(async () => {
            await vi.advanceTimersByTimeAsync(DAY);
        });
        expect(screen.queryByRole("region", { name: "Browser" })).toBeNull();
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
        [new Error("network"), "The live view could not be opened."],
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

    it("closes an open view while the server says someone else has control, and offers it again once it says it ended", async () => {
        backend.browser = { browserId: "b-1", idleUntil: Date.now() + 600_000 };
        backend.open.mockResolvedValue({ connectBy: Date.now() + 60_000, status: "ok", url: URL });
        const queryClient = mountCard();

        await userEvent.click(await screen.findByRole("button", { name: "Watch live" }));
        await screen.findByTitle(LIVE_VIEW);

        // This device's clock runs ahead of the server's: the lease reads as passed here, but not on the server's clock,
        // and the view closes all the same.
        backend.browser = { browserId: "b-1", control: { byYou: false, until: Date.now() - 1000 }, idleUntil: Date.now() + 600_000, now: Date.now() - 5000 };
        await act(async () => {
            await queryClient.invalidateQueries();
        });

        await vi.waitFor(() => {
            expect(screen.queryByTitle(LIVE_VIEW)).toBeNull();
        });
        expect(screen.getByRole("status").textContent).toBe("Someone else has control of this browser.");
        expect(screen.getByRole("button", { name: "Watch live" })).toHaveProperty("disabled", true);

        backend.browser = { browserId: "b-1", idleUntil: Date.now() + 600_000 };
        await act(async () => {
            await queryClient.invalidateQueries();
        });

        await vi.waitFor(() => {
            expect(screen.getByRole("button", { name: "Watch live" })).toHaveProperty("disabled", false);
        });
    });

    it("offers the view again once another person's lease ends on the server's clock, though no new answer comes", async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        // The server's clock is 3 s behind this device's; the lease has 10 s left on it.
        const serverNow = Date.now() - 3000;

        backend.browser = { browserId: "b-1", control: { byYou: false, until: serverNow + 10_000 }, idleUntil: serverNow + 600_000, now: serverNow };
        mountCard();

        await screen.findByText("Someone else has control of this browser.");
        const reads = backend.statusReads;

        // 7.5 s on: `until` has passed on this device's clock, but the lease has 2.5 s left on the server's.
        await act(async () => {
            await vi.advanceTimersByTimeAsync(7500);
        });
        expect(screen.getByRole("button", { name: "Watch live" })).toHaveProperty("disabled", true);

        // A lease that runs out writes nothing: the status stays the last answer, which still names it.
        await act(async () => {
            await vi.advanceTimersByTimeAsync(3000);
        });
        expect(screen.getByRole("button", { name: "Watch live" })).toHaveProperty("disabled", false);
        expect(screen.queryByText("Someone else has control of this browser.")).toBeNull();
        expect(backend.statusReads).toBe(reads);
    });

    it("says the browser status could not be read, instead of hiding the card, and reads it again on request", async () => {
        backend.statusError = new Error("network");
        backend.browser = { browserId: "b-1", currentUrl: "https://example.com/login", idleUntil: Date.now() + 600_000 };
        mountCard();

        const alert = await screen.findByRole("alert");

        expect(alert.textContent).toBe("Whether the agent is using a browser could not be checked.");
        expect(screen.getByRole("region", { name: "Browser" })).toBeTruthy();

        backend.statusError = undefined;
        await userEvent.click(screen.getByRole("button", { name: "Try again" }));

        expect(await screen.findByRole("button", { name: "Watch live" })).toBeTruthy();
        expect(screen.queryByRole("alert")).toBeNull();
    });

    it("says the status could not be read when a refetch fails after an answer of no browser", async () => {
        const queryClient = mountCard();

        // The first answer (no browser) has arrived; a refetch while it runs would only join it.
        await vi.waitFor(() => {
            expect(queryClient.isFetching()).toBe(0);
        });
        expect(backend.statusReads).toBe(1);
        expect(screen.queryByRole("region", { name: "Browser" })).toBeNull();

        backend.statusError = new Error("network");
        await act(async () => {
            await queryClient.refetchQueries();
        });

        const alert = await screen.findByRole("alert");

        expect(alert.textContent).toBe("Whether the agent is using a browser could not be checked.");

        backend.statusError = undefined;
        await userEvent.click(screen.getByRole("button", { name: "Try again" }));

        await vi.waitFor(() => {
            expect(screen.queryByRole("region", { name: "Browser" })).toBeNull();
        });
    });

    it("closes an open view and offers a retry when a later status read fails", async () => {
        backend.browser = { browserId: "b-1", currentUrl: "https://example.com/login", idleUntil: Date.now() + 600_000 };
        backend.open.mockResolvedValue({ connectBy: Date.now() + 60_000, status: "ok", url: URL });
        const queryClient = mountCard();

        await userEvent.click(await screen.findByRole("button", { name: "Watch live" }));
        await screen.findByTitle(LIVE_VIEW);

        backend.statusError = new Error("network");
        await act(async () => {
            await queryClient.refetchQueries();
        });

        const alert = await screen.findByRole("alert");

        expect(screen.queryByTitle(LIVE_VIEW)).toBeNull();
        expect(screen.queryByText("https://example.com/login")).toBeNull();
        expect(alert.textContent).toBe("Whether the agent is using a browser could not be checked.");

        backend.statusError = undefined;
        await userEvent.click(screen.getByRole("button", { name: "Try again" }));

        expect(await screen.findByRole("button", { name: "Watch live" })).toBeTruthy();
        expect(screen.queryByTitle(LIVE_VIEW)).toBeNull();
    });

    it("renews a frame that loaded only after its deadline, and offers a retry once the renewal does not connect either", async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        backend.browser = { browserId: "b-1", idleUntil: Date.now() + 600_000 };
        backend.open
            .mockResolvedValueOnce({ connectBy: Date.now() + 60_000, status: "ok", url: URL })
            .mockResolvedValueOnce({ connectBy: Date.now() + 60_000, status: "ok", url: OTHER_URL })
            .mockResolvedValueOnce({ connectBy: Date.now() + 60_000, status: "ok", url: URL });
        mountCard();

        await userEvent.click(await screen.findByRole("button", { name: "Watch live" }));
        const frame = await screen.findByTitle(LIVE_VIEW);

        // Backgrounded: the frame's load is held back past the deadline, so what loaded is the provider's refusal.
        setVisibility("hidden");
        await act(async () => {
            await vi.advanceTimersByTimeAsync(61_000);
        });
        fireEvent.load(frame);
        expect(screen.queryByTitle(LIVE_VIEW)).toBeNull();
        expect(backend.open).toHaveBeenCalledTimes(1);

        await act(async () => {
            setVisibility("visible");
        });
        expect(backend.open).toHaveBeenCalledTimes(2);
        expect(frameSource()).toBe(OTHER_URL);

        // The renewal does not connect either: no third request on its own, an error with a retry instead.
        await act(async () => {
            await vi.advanceTimersByTimeAsync(61_000);
        });
        expect(backend.open).toHaveBeenCalledTimes(2);
        expect(screen.getByRole("alert").textContent).toBe("The live view could not be opened.");

        await userEvent.click(screen.getByRole("button", { name: "Try again" }));
        await vi.waitFor(() => {
            expect(frameSource()).toBe(URL);
        });
        expect(backend.open).toHaveBeenCalledTimes(3);
    });
});
