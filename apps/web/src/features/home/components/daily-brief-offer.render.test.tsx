/* eslint-disable testing-library/no-node-access -- focus placement (document.activeElement) and the live region holding the answer are what these tests assert */

/**
 * The home page's one-time Daily Brief offer: nothing turns on without the
 * click, "Not now" only stores the answer, and "Turn it on" says when the first
 * brief arrives in the user's zone, with a way to change it.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => {
    return { dismiss: [] as unknown[], enable: [] as unknown[], refuseEnable: false };
});

vi.mock("@lingui/react/macro", () => {
    return {
        useLingui: () => {
            return {
                i18n: { locale: "en-GB" },
                t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values),
            };
        },
    };
});

vi.mock("@/lib/lunora/crpc", () => {
    // 2026-11-18 07:12 in Berlin (CET, UTC+1).
    const enable = {
        mutationOptions: () => {
            return {
                mutationFn: async (args: unknown) => {
                    calls.enable.push(args);

                    if (calls.refuseEnable) {
                        throw Object.assign(new Error("Managed by the organization"), { code: "FORBIDDEN" });
                    }

                    return { nextBriefAt: Date.UTC(2026, 10, 18, 6, 12), timeZone: "Europe/Berlin" };
                },
            };
        },
    };
    const dismiss = {
        mutationOptions: () => {
            return {
                mutationFn: async (args: unknown) => {
                    calls.dismiss.push(args);

                    return null;
                },
            };
        },
    };

    return {
        useCRPC: () => {
            return { notifications: { daily_brief: { dismissDailyBriefOffer: dismiss, setDailyBriefEnabled: enable } } };
        },
    };
});

vi.mock("@tanstack/react-router", () => {
    return {
        Link: ({ children, search }: { children: ReactNode; search: (previous: Record<string, unknown>) => Record<string, string> }) => (
            <a href={`?${new URLSearchParams(search({})).toString()}`}>{children}</a>
        ),
    };
});

const { default: DailyBriefOffer } = await import("./daily-brief-offer");

const DISMISSED = /we won't ask again/u;
const TURNED_ON = /Daily Brief is on/u;

const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
const tree = (offered: boolean) => createElement(QueryClientProvider, { client }, createElement(DailyBriefOffer, { offered }));
const mount = (offered: boolean) => render(tree(offered));

afterEach(() => {
    calls.dismiss.length = 0;
    calls.enable.length = 0;
    calls.refuseEnable = false;
});

describe("daily brief offer", () => {
    it("shows nothing when the overview does not offer it", () => {
        const { container } = mount(false);

        expect(container.textContent).toBe("");
    });

    it('"Not now" stores the answer and turns nothing on', async () => {
        mount(true);
        fireEvent.click(screen.getByRole("button", { name: "Not now" }));

        const confirmation = await screen.findByText(DISMISSED);

        expect(calls.dismiss).toHaveLength(1);
        expect(calls.enable).toHaveLength(0);
        // Focus moves to the answer, not back to the top of the page.
        expect(document.activeElement).toBe(confirmation);
        expect(screen.getByRole("status").contains(confirmation)).toBe(true);
    });

    it('"Turn it on" says when the first brief arrives in the user\'s zone and links to the setting', async () => {
        const { rerender } = mount(true);

        fireEvent.click(screen.getByRole("button", { name: "Turn it on" }));
        // The live overview stops offering it as soon as the write lands, before the answer returns.
        rerender(tree(false));
        // The card, and its live region, stay up while the answer is in flight.
        expect(screen.getByRole("heading", { name: "Daily Brief" })).toBeTruthy();
        expect(screen.getByRole("status")).toBeTruthy();

        const confirmation = await screen.findByText(TURNED_ON);

        expect(calls.enable).toEqual([{ enabled: true }]);
        expect(confirmation.textContent).toContain("Wednesday");
        expect(confirmation.textContent).toContain("07:12");
        expect(document.activeElement).toBe(confirmation);
        // Settings open over this page, at the account tab, scrolled to the daily brief.
        expect(screen.getByRole("link", { name: "Change it in settings" }).getAttribute("href")).toBe(
            "?settings=true&settingsTab=auth-account&settingsAnchor=daily-brief",
        );
        expect(screen.queryByRole("button", { name: "Turn it on" })).toBeNull();
    });

    it("keeps a refusal readable after the overview withdrew the offer", async () => {
        calls.refuseEnable = true;

        const { rerender } = mount(true);

        fireEvent.click(screen.getByRole("button", { name: "Turn it on" }));
        // An organization lock withdraws the offer while the write is refused.
        rerender(tree(false));

        const alert = await screen.findByRole("alert");

        expect(alert.textContent).toBe("Your organization manages the Daily Brief.");
    });
});
