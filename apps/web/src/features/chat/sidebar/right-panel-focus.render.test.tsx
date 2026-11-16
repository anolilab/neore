// @vitest-environment jsdom

import { Sidebar, SidebarProvider } from "@neore/ui/components/sidebar";
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => {
    const t = (strings: TemplateStringsArray | string, ...values: unknown[]) =>
        typeof strings === "string" ? strings : String.raw({ raw: strings }, ...values);

    return {
        Plural: () => null,
        useLingui: () => {
            return { i18n: { _: (value: string) => value }, t };
        },
    };
});

// The desktop layout: the phone media query does not match, so the sidebar renders its own panel.
Object.defineProperty(globalThis, "matchMedia", {
    configurable: true,
    value: (query: string) => {
        return {
            addEventListener: () => {},
            addListener: () => {},
            dispatchEvent: () => false,
            matches: false,
            media: query,
            onchange: null,
            removeEventListener: () => {},
            removeListener: () => {},
        };
    },
    writable: true,
});

describe("the right panel's focus area on desktop", () => {
    it("marks the panel itself, the element that has the viewport's height, not the empty wrapper around it", () => {
        render(
            <SidebarProvider open={{ right: { isMobileOpen: false, isOpen: true } }} sidebarNames={["right"]}>
                <Sidebar data-focus-area="panel" name="right" side="right">
                    <button type="button">Summary</button>
                </Sidebar>
            </SidebarProvider>,
        );

        // eslint-disable-next-line testing-library/no-node-access -- the focus area is a data attribute on the panel element
        const marked = document.querySelector<HTMLElement>('[data-focus-area="panel"]');

        // A focus area is measured by its own box: the outer wrapper is zero-height, the fixed panel is not.
        expect(marked?.dataset.slot).toBe("sidebar-container");
    });
});
