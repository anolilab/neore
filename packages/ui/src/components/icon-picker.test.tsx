// @vitest-environment jsdom

/**
 * The icon picker loads the icon list and map only once it opens, shows its skeleton until they are in, and reports
 * a failed download with a way to try again instead of an empty "No icon found".
 */
import { Rocket } from "lucide-react";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IconPicker } from "./icon-picker";

const { loader } = vi.hoisted(() => {
    return {
        loader: {
            calls: 0,
            next: undefined as { reject: (error: Error) => void; resolve: (value: unknown) => void } | undefined,
        },
    };
});

// eslint-disable-next-line no-restricted-syntax -- the download is what these tests hold back, fail and count
vi.mock("./lucide-icon-loader", () => {
    return {
        getLoadedLucideIconMap: () => undefined,
        isLucideIconNameShape: () => true,
        loadLucideIconMap: async () => {
            loader.calls += 1;

            return await new Promise((resolve: (value: unknown) => void, reject: (error: Error) => void) => {
                loader.next = { reject, resolve };
            });
        },
    };
});

// eslint-disable-next-line no-restricted-syntax -- a two-icon list instead of lucide's whole catalogue
vi.mock("../data/icons-data", () => {
    return {
        default: [
            { categories: ["shapes"], name: "rocket", tags: ["launch"] },
            { categories: ["shapes"], name: "anchor", tags: ["sea"] },
        ],
    };
});

// eslint-disable-next-line no-restricted-syntax -- no macro transform in this package's vitest; nothing to inject into
vi.mock("@lingui/react/macro", () => {
    return {
        useLingui: () => {
            return { t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values) };
        },
    };
});

const getIcon = (name: string) => (name === "rocket" ? Rocket : undefined);

const picker = (open: boolean) => (
    <IconPicker open={open}>
        <button type="button">Pick</button>
    </IconPicker>
);

// React only batches updates inside `act` when this flag is set.
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

// Each test's own container and root, set up in `beforeEach`.
const dom = {} as { container: HTMLDivElement; root: Root };

const render = async (node: ReactNode): Promise<void> => {
    await act(async () => {
        dom.root.render(node);
    });
};

/** Lets the pending promises (the stand-in download, its `then`) settle inside `act`. */
const settle = async (): Promise<void> => {
    await act(async () => {
        await new Promise((resolve: (value: unknown) => void) => {
            setTimeout(resolve, 0);
        });
    });
};

// The popover renders into a portal, so the whole document is searched.
const skeletons = () => document.querySelectorAll('[data-slot="skeleton"]');
const alertText = () => document.querySelector('[role="alert"]')?.textContent ?? null;
const hasText = (text: string) => document.body.textContent.includes(text);
const button = (name: string) => [...document.querySelectorAll("button")].find((element: HTMLButtonElement) => element.textContent === name);

beforeEach(() => {
    loader.calls = 0;
    loader.next = undefined;
    dom.container = document.createElement("div");
    document.body.append(dom.container);
    dom.root = createRoot(dom.container);
    vi.stubGlobal(
        "ResizeObserver",
        class {
            public disconnect(): void {}

            public observe(): void {}

            public unobserve(): void {}
        },
    );
});

afterEach(() => {
    act(() => {
        dom.root.unmount();
    });
    dom.container.remove();
});

describe("IconPicker", () => {
    it("downloads nothing until it opens", async () => {
        await render(picker(false));
        await settle();

        expect(loader.calls).toBe(0);

        await render(picker(true));
        await settle();

        expect(loader.calls).toBe(1);
    });

    it("shows its skeleton while the icons load, not an empty result", async () => {
        await render(picker(true));
        await settle();

        expect(loader.calls).toBe(1);
        expect(skeletons().length).toBeGreaterThan(0);
        expect(hasText("No icon found")).toBe(false);

        loader.next?.resolve(getIcon);
        await settle();

        expect(skeletons()).toHaveLength(0);
    });

    it("reports a failed download and loads again on Try again", async () => {
        await render(picker(true));
        await settle();

        loader.next?.reject(new Error("chunk failed to load"));
        await settle();

        expect(alertText()).toContain("The icons could not be loaded.");
        expect(hasText("No icon found")).toBe(false);

        act(() => {
            button("Try again")?.click();
        });
        await settle();

        expect(loader.calls).toBe(2);

        loader.next?.resolve(getIcon);
        await settle();

        expect(alertText()).toBeNull();
        expect(skeletons()).toHaveLength(0);
    });
});
