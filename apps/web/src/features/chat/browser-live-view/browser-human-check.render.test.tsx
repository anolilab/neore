import type { ToolPart } from "@neore/chat-ui/types";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { HumanCheckCard } from "./browser-human-check";
import { onBrowserControlRequest } from "./control-request";

// The unit-test transform does not compile Lingui macros (vi.mock is hoisted).
vi.mock("@lingui/react/macro", () => {
    return {
        useLingui: () => {
            return { t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values) };
        },
    };
});

const { backend } = vi.hoisted(() => {
    return { backend: { browser: null as Record<string, unknown> | null, fail: false } };
});

vi.mock("@/lib/lunora/crpc", () => {
    return {
        useCRPC: () => {
            return {
                browser: {
                    live_view: {
                        getThreadBrowser: {
                            queryOptions: (args: unknown) => {
                                return {
                                    queryFn: async () => {
                                        if (backend.fail) {
                                            throw new Error("status unavailable");
                                        }

                                        return backend.browser;
                                    },
                                    queryKey: ["getThreadBrowser", args],
                                };
                            },
                        },
                    },
                },
            };
        },
    };
});

/** The card's words when no picture of the page came with the ask. */
const NO_PICTURE = /No picture of the page could be taken/u;

/** The card's wording when it names the site. */
const SITE_NAMED = /a page on shop\.example\.com only a person can clear/u;

const PART = {
    output: {
        humanCheck: { site: "shop.example.com", status: "asked" },
        screenshot: "aGVsbG8=",
        screenshotFormat: "jpeg",
        success: false,
        url: "https://shop.example.com/item",
    },
    state: "output-available",
    toolCallId: "call-1",
    type: "tool-browser",
} as unknown as ToolPart;

const running = (overrides: Record<string, unknown> = {}) => {
    return { browserId: "b-1", canControl: true, idleUntil: Date.now() + 60_000, now: Date.now(), ...overrides };
};

const show = (part: ToolPart = PART, liveViewHere = true) =>
    render(
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
            <HumanCheckCard liveViewHere={liveViewHere} part={part} threadId="thread-1" />
        </QueryClientProvider>,
    );

afterEach(() => {
    backend.browser = null;
    backend.fail = false;
});

describe("the Needs you card", () => {
    it("names the site, shows what the browser sees, and asks the live view card for control", async () => {
        backend.browser = running();
        const asked: string[] = [];
        const stop = onBrowserControlRequest((threadId) => {
            asked.push(threadId);

            return true;
        });

        show();

        expect(screen.getByRole("region", { name: "Needs you" })).toBeTruthy();
        expect(screen.getByText(SITE_NAMED)).toBeTruthy();
        expect(screen.getByRole("img", { name: "What the agent's browser sees on shop.example.com" }).getAttribute("src")).toBe(
            "data:image/jpeg;base64,aGVsbG8=",
        );

        await userEvent.click(await screen.findByRole("button", { name: "Take control" }));
        expect(asked).toEqual(["thread-1"]);
        expect(screen.getByRole("status").textContent).toBe("");
        stop();
    });

    it("says the browser cannot be taken over, never that it closed, when no live view card took the request", async () => {
        backend.browser = running();
        show();

        await userEvent.click(await screen.findByRole("button", { name: "Take control" }));
        expect(screen.getByRole("status").textContent).toContain("The browser cannot be taken over right now.");
        expect(screen.getByRole("status").textContent).not.toContain("closed");
        expect(screen.queryByRole("button", { name: "Take control" })).toBeNull();
    });

    it("in a comparison column, which has no live view card, points to the model's own chat instead of saying the browser closed", async () => {
        backend.browser = running();
        show(PART, false);

        await waitFor(() => {
            expect(screen.getByRole("status").textContent).toContain("Open this model's chat on its own to take control");
        });
        expect(screen.getByRole("status").textContent).not.toContain("closed");
        expect(screen.queryByRole("button", { name: "Take control" })).toBeNull();
    });

    it.each([
        [null, "The browser has closed."],
        [running({ control: { byYou: true, until: Date.now() + 60_000 } }), "You have control."],
        [running({ control: { byYou: false, until: Date.now() + 60_000 } }), "Someone else has control of this browser."],
        [running({ canControl: false }), "Only someone who can write in this chat"],
    ])("offers no button when %j", async (browser, text) => {
        backend.browser = browser;
        show();

        await waitFor(() => {
            expect(screen.getByRole("status").textContent).toContain(text);
        });
        expect(screen.queryByRole("button", { name: "Take control" })).toBeNull();
    });

    it.each([
        [true, "You have control."],
        [false, "Someone else has control of this browser."],
    ])("offers Take control again once a lease (byYou %s) has lapsed on the server's clock", async (byYou, text) => {
        vi.useFakeTimers({ shouldAdvanceTime: true });

        try {
            // The server's clock runs 5 s ahead of this device's: the lease ends 10 s after the answer on the server's.
            const serverNow = Date.now() + 5000;

            backend.browser = running({ control: { byYou, until: serverNow + 10_000 }, now: serverNow });
            show();

            await waitFor(() => {
                expect(screen.getByRole("status").textContent).toContain(text);
            });
            expect(screen.queryByRole("button", { name: "Take control" })).toBeNull();

            await act(async () => {
                await vi.advanceTimersByTimeAsync(11_000);
            });

            expect(screen.getByRole("button", { name: "Take control" })).toBeTruthy();
            expect(screen.getByRole("status").textContent).toBe("");
        } finally {
            vi.useRealTimers();
        }
    });

    it("does not call a browser closed when its status could not be read, and asks again on Try again", async () => {
        backend.browser = running();
        backend.fail = true;
        show();

        await waitFor(() => {
            expect(screen.getByRole("status").textContent).toContain("could not be checked");
        });
        expect(screen.getByRole("status").textContent).not.toContain("closed");

        backend.fail = false;
        await userEvent.click(screen.getByRole("button", { name: "Try again" }));

        expect(await screen.findByRole("button", { name: "Take control" })).toBeTruthy();
        expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    });

    it("says so in text when no picture of the page came with the ask", async () => {
        backend.browser = running();
        show({
            ...PART,
            output: { humanCheck: { site: "shop.example.com", status: "asked" }, success: false, url: "https://shop.example.com/item" },
        } as unknown as ToolPart);

        expect(screen.getByText(NO_PICTURE)).toBeTruthy();
        expect(screen.queryByRole("img")).toBeNull();
        expect(await screen.findByRole("button", { name: "Take control" })).toBeTruthy();
    });
});
