import { api } from "@neore/backend/api";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
                canControl?: boolean;
                control?: { byYou: boolean; until: number };
                currentUrl?: string;
                idleUntil: number;
                /** The server's clock at the answer; this device's when left out. */
                now?: number;
            } | null,
            handBack: vi.fn(),
            /** Whether an admin acts as this account. */
            impersonating: false,
            keep: vi.fn(),
            navigate: vi.fn(),
            /** When set, the status read fails with it. */
            statusError: undefined as Error | undefined,
            open: vi.fn(),
            take: vi.fn(),
            /** How often the status was read. */
            statusReads: 0,
        },
    };
});

vi.mock("@/features/admin/hooks/use-is-impersonating", () => {
    return { useImpersonating: () => backend.impersonating };
});

vi.mock("@/lib/lunora/crpc", () => {
    return {
        useAction: (reference: unknown) => {
            if (reference === api.browser.live_view.takeControl) {
                return backend.take;
            }

            return reference === api.browser.live_view.navigateInControl ? backend.navigate : backend.open;
        },
        useCRPC: () => {
            return {
                browser: {
                    live_view: {
                        handBack: {
                            mutationOptions: () => {
                                return { mutationFn: backend.handBack };
                            },
                        },
                        keepControl: {
                            mutationOptions: () => {
                                return { mutationFn: backend.keep };
                            },
                        },
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
    backend.impersonating = false;
});

// The last test's card unmounts after it, and hands back a tick later: that call must not count in this test.
beforeEach(async () => {
    await new Promise((resolve) => {
        setTimeout(resolve, 5);
    });

    for (const mock of [backend.open, backend.handBack, backend.keep, backend.navigate, backend.take]) {
        mock.mockReset();
    }
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

    describe("taking control", () => {
        const CONTROL_URL = "https://live.browser.run/ui/view?mode=tab&control";
        const CONTROL_VIEW = "Live view of the agent's browser (you have control)";
        const READ_ONLY_VIEW = "Live view of the agent's browser (read-only)";

        const controllable = (): void => {
            backend.browser = { browserId: "b-1", canControl: true, idleUntil: Date.now() + 600_000 };
            backend.open.mockResolvedValue({ connectBy: Date.now() + 600_000, status: "ok", url: URL });
        };

        /** Pushes a new status, as the live query would after a write. */
        const push = async (queryClient: QueryClient, next: NonNullable<typeof backend.browser>): Promise<void> => {
            backend.browser = next;
            await act(async () => {
                await queryClient.invalidateQueries();
            });
        };

        /**
         * The person takes control under `claim`; the status then says they hold the lease until `until`. The view
         * connects, unless `connect` is false (its URL is then renewed past the connect deadline).
         */
        const takeControl = async (queryClient: QueryClient, until = Date.now() + 120_000, connect = true): Promise<void> => {
            backend.take.mockResolvedValueOnce({ claim: "claim-1", connectBy: Date.now() + 60_000, status: "ok", url: CONTROL_URL });
            await userEvent.click(await screen.findByRole("button", { name: "Take control" }));
            await push(queryClient, { ...backend.browser!, control: { byYou: true, until } });

            const frame = await screen.findByTitle(CONTROL_VIEW);

            if (connect) {
                fireEvent.load(frame);
            }
        };

        const typeAddress = async (url = "https://example.com/next"): Promise<void> => {
            fireEvent.change(screen.getByRole("textbox", { name: "Page address" }), { target: { value: url } });
            await userEvent.click(screen.getByRole("button", { name: "Go" }));
        };

        it("opens the interactive view, and hands back under its claim to a read-only one", async () => {
            controllable();
            backend.open.mockResolvedValue({ connectBy: Date.now() + 60_000, status: "ok", url: URL });
            const queryClient = mountCard();

            await takeControl(queryClient);
            expect(frameSource()).toBe(CONTROL_URL);
            expect(backend.open).not.toHaveBeenCalled();

            await userEvent.click(screen.getByRole("button", { name: "Hand back" }));

            expect(backend.handBack.mock.calls[0]?.[0]).toEqual({ claim: "claim-1", reason: "handed_back", threadId: THREAD });
            expect(await screen.findByTitle(READ_ONLY_VIEW)).toBeTruthy();
            expect(screen.queryByTitle(CONTROL_VIEW)).toBeNull();
            expect(await screen.findByText("You handed the browser back to the agent.")).toBeTruthy();
        });

        it("offers no control to a read-only viewer", async () => {
            backend.browser = { browserId: "b-1", canControl: false, idleUntil: Date.now() + 60_000 };
            mountCard();

            await screen.findByRole("button", { name: "Watch live" });
            expect(screen.queryByRole("button", { name: "Take control" })).toBeNull();
        });

        it.each([
            ["busy", "The agent is finishing a browser action, which can take over a minute. Try again shortly."],
            ["taken", "Someone else has control of this browser."],
            ["unavailable", "The live view is not available right now."],
        ])("says why control was not given when the answer is %s", async (answer, message) => {
            controllable();
            backend.take.mockResolvedValue({ status: answer });
            mountCard();

            await userEvent.click(await screen.findByRole("button", { name: "Take control" }));

            expect(await screen.findByRole("status")).toHaveProperty("textContent", message);
        });

        it("keeps sending the old claim while a renewal is minted, and the new one once it answers ok", async () => {
            vi.useFakeTimers({ shouldAdvanceTime: true });
            controllable();
            const queryClient = mountCard();
            const renewal: ((value: unknown) => void)[] = [];

            await takeControl(queryClient, Date.now() + 90_000, false);
            backend.take.mockImplementationOnce(
                async () =>
                    await new Promise((resolve) => {
                        renewal.push(resolve);
                    }),
            );
            // The interactive URL never connected: its one renewal is asked for.
            await act(async () => {
                await vi.advanceTimersByTimeAsync(61_000);
            });
            expect(backend.take).toHaveBeenCalledTimes(2);

            await userEvent.click(screen.getByRole("button", { name: "Keep control" }));
            expect(backend.keep.mock.calls[0]?.[0]).toEqual({ claim: "claim-1", threadId: THREAD });

            await act(async () => {
                renewal[0]?.({ claim: "claim-2", connectBy: Date.now() + 60_000, status: "ok", url: OTHER_URL });
            });
            expect(frameSource()).toBe(OTHER_URL);

            await userEvent.click(screen.getByRole("button", { name: "Hand back" }));
            expect(backend.handBack.mock.calls[0]?.[0]).toEqual({ claim: "claim-2", reason: "handed_back", threadId: THREAD });
        });

        it("closes the interactive view and hands back when a renewal answers unavailable", async () => {
            vi.useFakeTimers({ shouldAdvanceTime: true });
            controllable();
            const queryClient = mountCard();

            await takeControl(queryClient, Date.now() + 600_000, false);
            backend.take.mockResolvedValueOnce({ status: "unavailable" });
            await act(async () => {
                await vi.advanceTimersByTimeAsync(61_000);
            });

            expect(screen.queryByTitle(CONTROL_VIEW)).toBeNull();
            expect(screen.getByText("The live view is not available right now.")).toBeTruthy();
            expect(backend.handBack.mock.calls[0]?.[0]).toEqual({ claim: "claim-1", reason: "left", threadId: THREAD });
            expect(screen.queryByRole("button", { name: "Hand back" })).toBeNull();
        });

        it("closes the interactive view once keepControl answers that this tab no longer holds control", async () => {
            vi.useFakeTimers({ shouldAdvanceTime: true });
            controllable();
            backend.keep.mockResolvedValue(null);
            const queryClient = mountCard();

            await takeControl(queryClient, Date.now() + 40_000);
            await act(async () => {
                await vi.advanceTimersByTimeAsync(11_000);
            });
            await userEvent.click(screen.getByRole("button", { name: "Keep control" }));

            await vi.waitFor(() => {
                expect(screen.queryByTitle(CONTROL_VIEW)).toBeNull();
            });
            expect(screen.getByText("You no longer have control of the browser.")).toBeTruthy();
            expect(screen.getByRole("button", { name: "Take control" })).toBeTruthy();
        });

        it("closes the interactive view and hands back once the person may no longer write", async () => {
            controllable();
            const queryClient = mountCard();

            await takeControl(queryClient);
            await push(queryClient, { ...backend.browser!, canControl: false });

            await vi.waitFor(() => {
                expect(screen.queryByTitle(CONTROL_VIEW)).toBeNull();
            });
            expect(backend.handBack.mock.calls[0]?.[0]).toEqual({ claim: "claim-1", reason: "left", threadId: THREAD });
            expect(screen.queryByRole("button", { name: "Take control" })).toBeNull();
        });

        it("hands back under its claim when the card unmounts as the status answers no browser", async () => {
            controllable();
            const queryClient = mountCard();

            await takeControl(queryClient);
            backend.browser = null;
            await act(async () => {
                await queryClient.invalidateQueries();
            });
            await act(async () => {
                await new Promise((resolve) => {
                    setTimeout(resolve, 10);
                });
            });

            expect(screen.queryByTitle(CONTROL_VIEW)).toBeNull();
            expect(backend.handBack.mock.calls.map(([args]) => args)).toEqual([{ claim: "claim-1", reason: "left", threadId: THREAD }]);
        });

        it("hands back when the person hides the view", async () => {
            controllable();
            const queryClient = mountCard();

            await takeControl(queryClient);
            await userEvent.click(screen.getByRole("button", { name: "Hide live view" }));
            await act(async () => {
                await new Promise((resolve) => {
                    setTimeout(resolve, 10);
                });
            });

            expect(backend.handBack.mock.calls.map(([args]) => args)).toEqual([{ claim: "claim-1", reason: "left", threadId: THREAD }]);
            expect(screen.queryByTitle(LIVE_VIEW)).toBeNull();
        });

        it("hands back and closes the interactive view when the person leaves the page", async () => {
            controllable();
            const queryClient = mountCard();

            await takeControl(queryClient);
            await act(async () => {
                globalThis.dispatchEvent(new Event("pagehide"));
            });

            expect(backend.handBack.mock.calls.map(([args]) => args)).toEqual([{ claim: "claim-1", reason: "left", threadId: THREAD }]);
            expect(screen.queryByTitle(CONTROL_VIEW)).toBeNull();
            expect(screen.queryByText("Opening the live view…")).toBeNull();
        });

        it("ignores a page answer that comes back after control moved on to a new lease", async () => {
            controllable();
            const answers: ((value: unknown) => void)[] = [];

            backend.navigate.mockImplementationOnce(
                async () =>
                    await new Promise((resolve) => {
                        answers.push(resolve);
                    }),
            );
            const queryClient = mountCard();

            await takeControl(queryClient);
            await typeAddress();
            await userEvent.click(screen.getByRole("button", { name: "Hand back" }));
            await push(queryClient, { ...backend.browser!, control: undefined });
            await takeControl(queryClient);

            await act(async () => {
                answers[0]?.({ error: "You do not have control of the browser.", status: "refused" });
            });

            expect(screen.getByTitle(CONTROL_VIEW)).toBeTruthy();
            expect(screen.getByRole("button", { name: "Go" })).toHaveProperty("disabled", false);
        });

        it("hands back a lease whose answer came after the person hid the view", async () => {
            controllable();
            const late: ((value: unknown) => void)[] = [];

            backend.take.mockImplementationOnce(
                async () =>
                    await new Promise((resolve) => {
                        late.push(resolve);
                    }),
            );
            mountCard();

            await userEvent.click(await screen.findByRole("button", { name: "Take control" }));
            await userEvent.click(screen.getByRole("button", { name: "Hide live view" }));
            await act(async () => {
                late[0]?.({ claim: "claim-late", connectBy: Date.now() + 60_000, status: "ok", url: CONTROL_URL });
            });

            expect(backend.handBack.mock.calls[0]?.[0]).toEqual({ claim: "claim-late", reason: "left", threadId: THREAD });
            expect(screen.queryByTitle(LIVE_VIEW)).toBeNull();
        });

        it("warns before an idle hand back, keeps control on request, and closes the view once control lapsed", async () => {
            vi.useFakeTimers({ shouldAdvanceTime: true });
            controllable();
            backend.keep.mockResolvedValue({ until: Date.now() + 120_000 });
            const queryClient = mountCard();

            await takeControl(queryClient, Date.now() + 40_000);
            expect(screen.queryByRole("button", { name: "Keep control" })).toBeNull();

            await act(async () => {
                await vi.advanceTimersByTimeAsync(11_000);
            });
            await userEvent.click(screen.getByRole("button", { name: "Keep control" }));
            expect(backend.keep.mock.calls[0]?.[0]).toEqual({ claim: "claim-1", threadId: THREAD });

            await act(async () => {
                await vi.advanceTimersByTimeAsync(30_000);
            });

            expect(screen.queryByTitle(CONTROL_VIEW)).toBeNull();
            expect(screen.getByText("Control of the browser is back with the agent.")).toBeTruthy();
            expect(screen.getByRole("button", { name: "Take control" })).toBeTruthy();
        });

        it("opens a typed page under the claim, reads the status again, and says why one was refused", async () => {
            controllable();
            backend.navigate.mockResolvedValue({ error: "URL is not allowed", status: "refused" });
            const queryClient = mountCard();

            await takeControl(queryClient);
            const reads = backend.statusReads;

            await typeAddress();

            expect(backend.navigate.mock.calls[0]?.[0]).toEqual({ claim: "claim-1", threadId: THREAD, url: "https://example.com/next" });
            const alert = await screen.findByRole("alert");

            expect(alert).toHaveProperty("textContent", "That page could not be opened: URL is not allowed");
            expect(backend.statusReads).toBeGreaterThan(reads);

            const address = screen.getByRole("textbox", { name: "Page address" });

            expect(address.getAttribute("aria-invalid")).toBe("true");
            expect(address.getAttribute("aria-describedby")).toBe(alert.id);
        });

        it("waits for a slow page without giving up, and keeps the view while it loads", async () => {
            vi.useFakeTimers({ shouldAdvanceTime: true });
            controllable();
            backend.navigate.mockImplementation(async () => {
                await new Promise((resolve) => {
                    setTimeout(resolve, 70_000);
                });

                return { status: "ok" };
            });
            const queryClient = mountCard();

            // A load grants the lease a fresh window: the status the page's load pushes moves `until`.
            await takeControl(queryClient, Date.now() + 600_000);
            await typeAddress();
            expect(screen.getByText("Opening the page. This can take up to a minute.")).toBeTruthy();
            expect(screen.getByRole("button", { name: "Go" })).toHaveProperty("disabled", true);

            await act(async () => {
                await vi.advanceTimersByTimeAsync(70_100);
            });

            expect(screen.queryByText("Opening the page. This can take up to a minute.")).toBeNull();
            expect(screen.getByTitle(CONTROL_VIEW)).toBeTruthy();
            expect(screen.queryByRole("alert")).toBeNull();
        });

        it("says a timed-out page is still loading for about 15 seconds", async () => {
            vi.useFakeTimers({ shouldAdvanceTime: true });
            controllable();
            backend.navigate.mockResolvedValue({ error: "The page you opened is still loading.", status: "refused" });
            const queryClient = mountCard();

            await takeControl(queryClient, Date.now() + 600_000);
            await typeAddress();

            expect(await screen.findByText("The page you opened is still loading.")).toBeTruthy();
            expect(screen.queryByRole("alert")).toBeNull();
            await act(async () => {
                await vi.advanceTimersByTimeAsync(15_100);
            });
            expect(screen.queryByText("The page you opened is still loading.")).toBeNull();
        });

        it.each([
            [{ status: "closed" }, "The agent's browser closed while the page loaded."],
            [{ error: "You do not have control of the browser.", status: "refused" }, "You no longer have control of the browser."],
        ])("closes the interactive view when navigating answers %o", async (answer, message) => {
            controllable();
            backend.navigate.mockResolvedValue(answer);
            const queryClient = mountCard();

            await takeControl(queryClient);
            await typeAddress();

            expect(await screen.findByText(message)).toBeTruthy();
            expect(screen.queryByTitle(CONTROL_VIEW)).toBeNull();
        });

        it("closes the interactive view and offers control again when the renderer replaced the browser", async () => {
            controllable();
            const queryClient = mountCard();

            await takeControl(queryClient);
            await push(queryClient, { browserId: "b-2", canControl: true, idleUntil: Date.now() + 600_000 });

            expect(await screen.findByText("The agent's browser was replaced, and control went back to the agent. You can take control again.")).toBeTruthy();
            expect(screen.queryByTitle(LIVE_VIEW)).toBeNull();
            expect(screen.getByRole("button", { name: "Take control" })).toBeTruthy();
            expect(backend.take).toHaveBeenCalledTimes(1);
        });

        it("says control is not available while impersonating, with no retry", async () => {
            controllable();
            backend.impersonating = true;
            backend.take.mockRejectedValue({ code: "FORBIDDEN" });
            mountCard();

            await userEvent.click(await screen.findByRole("button", { name: "Take control" }));

            expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Taking control is not available while impersonating.");
            expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
        });

        it("closes the interactive view and hands back when keeping control is refused while impersonating", async () => {
            vi.useFakeTimers({ shouldAdvanceTime: true });
            controllable();
            backend.impersonating = true;
            backend.keep.mockRejectedValue({ code: "FORBIDDEN" });
            const queryClient = mountCard();

            await takeControl(queryClient, Date.now() + 40_000);
            await act(async () => {
                await vi.advanceTimersByTimeAsync(11_000);
            });
            await userEvent.click(screen.getByRole("button", { name: "Keep control" }));

            expect(await screen.findByText("Taking control is not available while impersonating.")).toBeTruthy();
            expect(screen.queryByTitle(CONTROL_VIEW)).toBeNull();
            expect(backend.handBack.mock.calls.map(([args]) => args)).toEqual([{ claim: "claim-1", reason: "left", threadId: THREAD }]);
        });

        it("closes the interactive view and hands back when opening a page is refused while impersonating", async () => {
            controllable();
            backend.impersonating = true;
            backend.navigate.mockRejectedValue({ data: { code: "FORBIDDEN" } });
            const queryClient = mountCard();

            await takeControl(queryClient);
            await typeAddress();

            expect(await screen.findByText("Taking control is not available while impersonating.")).toBeTruthy();
            expect(screen.queryByTitle(CONTROL_VIEW)).toBeNull();
            expect(backend.handBack.mock.calls.map(([args]) => args)).toEqual([{ claim: "claim-1", reason: "left", threadId: THREAD }]);
        });

        it("keeps a new lease while the status read still answers from before it was written", async () => {
            controllable();
            // `connectBy` names the server's clock when the lease was answered: a read before that has not seen it.
            backend.take.mockResolvedValueOnce({ claim: "claim-1", connectBy: Date.now() + 61_000, status: "ok", url: CONTROL_URL });
            const queryClient = mountCard();

            await userEvent.click(await screen.findByRole("button", { name: "Take control" }));
            expect(await screen.findByTitle(CONTROL_VIEW)).toBeTruthy();

            // A late read from before the lease (the person's earlier lease, handed back) changes nothing.
            await push(queryClient, { ...backend.browser!, control: undefined, now: Date.now() - 1000 });
            expect(screen.getByTitle(CONTROL_VIEW)).toBeTruthy();
            expect(backend.handBack).not.toHaveBeenCalled();

            // A read after the lease was written that says it is gone ends it.
            await push(queryClient, { ...backend.browser!, control: undefined, now: Date.now() + 2000 });
            await vi.waitFor(() => {
                expect(screen.queryByTitle(CONTROL_VIEW)).toBeNull();
            });
            expect(backend.handBack.mock.calls.map(([args]) => args)).toEqual([{ claim: "claim-1", reason: "left", threadId: THREAD }]);
        });

        it("closes a lease no status read ever confirmed once it would have run out unrenewed, warning first", async () => {
            vi.useFakeTimers({ shouldAdvanceTime: true });
            controllable();
            backend.browser = { ...backend.browser!, idleUntil: Date.now() + 3_600_000 };
            // Answered after every status read the card gets: none of them has seen the lease (its push was lost).
            backend.take.mockResolvedValueOnce({ claim: "claim-1", connectBy: Date.now() + 600_000, status: "ok", url: CONTROL_URL });
            mountCard();

            await userEvent.click(await screen.findByRole("button", { name: "Take control" }));
            fireEvent.load(await screen.findByTitle(CONTROL_VIEW));

            await act(async () => {
                await vi.advanceTimersByTimeAsync(631_000);
            });
            expect(screen.getByRole("button", { name: "Keep control" })).toBeTruthy();
            expect(backend.handBack).not.toHaveBeenCalled();

            await act(async () => {
                await vi.advanceTimersByTimeAsync(30_000);
            });
            expect(screen.queryByTitle(CONTROL_VIEW)).toBeNull();
            expect(backend.handBack.mock.calls.map(([args]) => args)).toEqual([{ claim: "claim-1", reason: "left", threadId: THREAD }]);
        });

        it.each([
            [
                "the browser was replaced",
                async (queryClient: QueryClient): Promise<void> => {
                    await push(queryClient, { browserId: "b-2", canControl: true, idleUntil: Date.now() + 600_000 });
                    await screen.findByText("The agent's browser was replaced, and control went back to the agent. You can take control again.");
                },
            ],
            [
                "the person left the page",
                async (): Promise<void> => {
                    await act(async () => {
                        globalThis.dispatchEvent(new Event("pagehide"));
                    });
                },
            ],
        ])("hands back a lease whose answer came after %s, and frames nothing", async (_, stopWanting) => {
            controllable();
            const late: ((value: unknown) => void)[] = [];

            backend.take.mockImplementationOnce(
                async () =>
                    await new Promise((resolve) => {
                        late.push(resolve);
                    }),
            );
            const queryClient = mountCard();

            await userEvent.click(await screen.findByRole("button", { name: "Take control" }));
            await stopWanting(queryClient);
            await act(async () => {
                late[0]?.({ claim: "claim-late", connectBy: Date.now() + 60_000, status: "ok", url: CONTROL_URL });
            });

            expect(backend.handBack.mock.calls.map(([args]) => args)).toEqual([{ claim: "claim-late", reason: "left", threadId: THREAD }]);
            expect(screen.queryByTitle(CONTROL_VIEW)).toBeNull();
            expect(screen.queryByRole("button", { name: "Hand back" })).toBeNull();
        });

        it("hands back a lease whose renewed view does not connect either", async () => {
            vi.useFakeTimers({ shouldAdvanceTime: true });
            controllable();
            const queryClient = mountCard();

            await takeControl(queryClient, Date.now() + 600_000, false);
            backend.take.mockResolvedValueOnce({ claim: "claim-2", connectBy: Date.now() + 61_000, status: "ok", url: OTHER_URL });
            await act(async () => {
                await vi.advanceTimersByTimeAsync(61_000);
            });
            expect(frameSource()).toBe(OTHER_URL);

            await act(async () => {
                await vi.advanceTimersByTimeAsync(61_000);
            });

            expect(screen.getByRole("alert").textContent).toBe("The live view could not be opened.");
            expect(backend.handBack.mock.calls.map(([args]) => args)).toEqual([{ claim: "claim-2", reason: "left", threadId: THREAD }]);
            expect(screen.queryByRole("button", { name: "Hand back" })).toBeNull();
        });

        it("hands back a lease whose renewal failed", async () => {
            vi.useFakeTimers({ shouldAdvanceTime: true });
            controllable();
            const queryClient = mountCard();

            await takeControl(queryClient, Date.now() + 600_000, false);
            backend.take.mockRejectedValueOnce(new Error("network"));
            await act(async () => {
                await vi.advanceTimersByTimeAsync(61_000);
            });

            expect(screen.getByRole("alert").textContent).toBe("The live view could not be opened.");
            expect(backend.handBack.mock.calls.map(([args]) => args)).toEqual([{ claim: "claim-1", reason: "left", threadId: THREAD }]);
            expect(screen.queryByRole("button", { name: "Hand back" })).toBeNull();
        });

        it("tries a failed hand back again, and says so once it keeps failing", async () => {
            vi.useFakeTimers({ shouldAdvanceTime: true });
            controllable();
            backend.handBack.mockRejectedValue(new Error("network"));
            const queryClient = mountCard();

            await takeControl(queryClient);
            await userEvent.click(screen.getByRole("button", { name: "Hand back" }));
            await act(async () => {
                await vi.advanceTimersByTimeAsync(10_000);
            });

            expect(backend.handBack).toHaveBeenCalledTimes(4);
            expect(screen.getByText("The browser could not be handed back. The agent gets it back on its own after two minutes without input.")).toBeTruthy();
            expect(screen.queryByText("You handed the browser back to the agent.")).toBeNull();
        });

        it("shows the controlled browser's page: the status's at first, then the one a page load answered", async () => {
            controllable();
            backend.browser = { ...backend.browser!, currentUrl: "https://example.com/login" };
            backend.navigate.mockResolvedValue({ status: "ok", url: "https://example.com/welcome" });
            const queryClient = mountCard();

            await takeControl(queryClient);
            const address = screen.getByRole("textbox", { name: "Page address" });

            expect(address).toHaveProperty("value", "https://example.com/login");

            await typeAddress("https://example.com/next");

            await vi.waitFor(() => {
                expect(address).toHaveProperty("value", "https://example.com/welcome");
            });
            expect(screen.getByRole("region", { name: "Browser" }).textContent).toContain("https://example.com/welcome");
            expect(screen.getByRole("region", { name: "Browser" }).textContent).not.toContain("https://example.com/login");
        });
    });
});
