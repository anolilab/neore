import type { ToolPart } from "@neore/chat-ui/types";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
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
    return { backend: { browser: null as Record<string, unknown> | null } };
});

vi.mock("@/lib/lunora/crpc", () => {
    return {
        useCRPC: () => {
            return {
                browser: {
                    live_view: {
                        getThreadBrowser: {
                            queryOptions: (args: unknown) => {
                                return { queryFn: async () => backend.browser, queryKey: ["getThreadBrowser", args] };
                            },
                        },
                    },
                },
            };
        },
    };
});

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

const show = () =>
    render(
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
            <HumanCheckCard part={PART} threadId="thread-1" />
        </QueryClientProvider>,
    );

afterEach(() => {
    backend.browser = null;
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
        expect(screen.queryByRole("status")).toBeNull();
        stop();
    });

    it("says the browser closed when no live view card took the request", async () => {
        backend.browser = running();
        show();

        await userEvent.click(await screen.findByRole("button", { name: "Take control" }));
        expect(screen.getByRole("status").textContent).toContain("The browser has closed.");
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

        const shown = await screen.findByRole("status");

        expect(shown.textContent).toContain(text);
        expect(screen.queryByRole("button", { name: "Take control" })).toBeNull();
    });
});
