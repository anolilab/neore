// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import Shimmer from "./shimmer";

// React only batches updates inside `act` when this flag is set.
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

const renderShimmer = (node = <Shimmer>Thinking...</Shimmer>) => {
    const container = document.createElement("div");
    const root = createRoot(container);

    act(() => {
        root.render(node);
    });

    return {
        current: () => container.firstElementChild as HTMLElement,
        element: container.firstElementChild as HTMLElement,
        rerender: (next: ReactNode) => act(() => root.render(next)),
        unmount: () => act(() => root.unmount()),
    };
};

const requireFromUi = createRequire(join(import.meta.dirname, "../../../package.json"));
const tailwindDirectory = dirname(requireFromUi.resolve("tailwindcss/package.json"));
const { compile } = requireFromUi("tailwindcss") as {
    compile: (
        css: string,
        options: {
            base: string;
            loadModule: (id: string, base: string) => Promise<{ base: string; module: () => void; path: string }>;
            loadStylesheet: (id: string, base: string) => Promise<{ base: string; content: string; path: string }>;
        },
    ) => Promise<{ build: (candidates: string[]) => string }>;
};

/**
 * What Tailwind generates from `global.css` for `candidates`: the real stylesheet and Tailwind's own core, with the
 * imports that add nothing here (tw-animate-css, shadcn, the typography plugin) left empty.
 */
const generatedCss = async (candidates: string[]): Promise<string> => {
    const compiler = await compile(readFileSync(join(import.meta.dirname, "../../global.css"), "utf8"), {
        base: join(import.meta.dirname, "../.."),
        loadModule: async (id: string, base: string) => {
            return { base, module: () => {}, path: id };
        },
        loadStylesheet: async (id: string, base: string) => {
            if (id === "tailwindcss") {
                const path = join(tailwindDirectory, "index.css");

                return { base: tailwindDirectory, content: readFileSync(path, "utf8"), path };
            }

            return { base, content: "", path: id };
        },
    });

    return compiler.build(candidates);
};

/** The classes a rendered shimmer carries: what Tailwind finds in the source when it builds the app. */
const shimmerClasses = (): string[] => {
    const { element, unmount } = renderShimmer();
    const classes = [...element.classList];

    unmount();

    return classes;
};

const SHIMMER_RULE =
    /\.animate-text-shimmer \{\s*animation: text-shimmer var\(--shimmer-duration, 2s\) steps\(30\) infinite;\s*&\[data-paused\] \{\s*animation-play-state: paused;/u;
const SHIMMER_KEYFRAMES = /@keyframes text-shimmer \{\s*from \{\s*background-position: 100% center;\s*\}\s*to \{\s*background-position: 0% center;/u;
const REDUCED_MOTION_OVERRIDE = /^\.motion-reduce\\:animate-none \{\s*animation: none;/u;
const THEME_SHIMMER_VARIABLE = /--animate-text-shimmer:/u;
const REDUCED_MOTION_RULE_START = /\.motion-reduce\\:animate-none \{/u;
const REDUCED_MOTION_QUERY = /^@media \(prefers-reduced-motion: reduce\) \{\s*$/u;

describe("Shimmer", () => {
    it("animates with the CSS keyframe, timed by its duration", () => {
        const { element, unmount } = renderShimmer(<Shimmer duration={1}>Thinking...</Shimmer>);

        expect(element.tagName).toBe("P");
        expect(element.textContent).toBe("Thinking...");
        expect(element.classList.contains("animate-text-shimmer")).toBe(true);
        expect(element.style.getPropertyValue("--shimmer-duration")).toBe("1s");
        expect(element.style.getPropertyValue("--spread")).toBe(`${"Thinking...".length * 2}px`);
        expect(element.getAttribute("role")).toBe("status");
        unmount();
    });

    it("renders as the element it is given", () => {
        const { element, unmount } = renderShimmer(<Shimmer as="h2">Thinking...</Shimmer>);

        expect(element.tagName).toBe("H2");
        expect(element.getAttribute("role")).toBeNull();
        unmount();
    });

    it("stops the loop under reduced motion and rests at the sweep's end", () => {
        const { element, unmount } = renderShimmer();

        expect(element.classList.contains("motion-reduce:animate-none")).toBe(true);
        expect(element.classList.contains("[background-position:0%_center]")).toBe(true);
        unmount();
    });

    it("gets a generated rule that steps the sweep, timed on the element itself, and stops under reduced motion", async () => {
        const css = await generatedCss(shimmerClasses());
        const rule = css.indexOf(".animate-text-shimmer {");
        const override = css.search(REDUCED_MOTION_RULE_START);

        // The animation is on the element, where its inline `--shimmer-duration` is set: a `@theme` variable would be
        // resolved on :root instead, and every shimmer would run at the 2s fallback.
        expect(css).toMatch(SHIMMER_RULE);
        expect(css).not.toMatch(THEME_SHIMMER_VARIABLE);
        expect(css).toMatch(SHIMMER_KEYFRAMES);
        expect(css.slice(override)).toMatch(REDUCED_MOTION_OVERRIDE);
        // …inside the reduced-motion query.
        expect(css.slice(css.lastIndexOf("@media", override), override)).toMatch(REDUCED_MOTION_QUERY);
        // Later in the stylesheet, so it wins over the utility.
        expect(rule).toBeGreaterThan(-1);
        expect(override).toBeGreaterThan(rule);
    });
});

/** An observer that cannot start: a plain function can be `new`-ed, and this one throws when it is. */
function ThrowingObserver(): never {
    throw new Error("observer unavailable");
}

describe("Shimmer off-screen", () => {
    const observers: { callback: IntersectionObserverCallback; disconnected: boolean; targets: Element[] }[] = [];

    class FakeIntersectionObserver {
        private readonly record: (typeof observers)[number];

        public constructor(callback: IntersectionObserverCallback) {
            this.record = { callback, disconnected: false, targets: [] };
            observers.push(this.record);
        }

        public disconnect(): void {
            this.record.disconnected = true;
        }

        public observe(target: Element): void {
            this.record.targets.push(target);
        }
    }

    const report = (isIntersecting: boolean) => {
        const [observer] = observers;

        act(() => {
            observer!.callback([{ isIntersecting } as IntersectionObserverEntry], observer as unknown as IntersectionObserver);
        });
    };

    afterEach(() => {
        observers.length = 0;
        vi.unstubAllGlobals();
        vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    });

    it("pauses while it is out of view and runs again when it comes back", () => {
        vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
        const { element, unmount } = renderShimmer();

        expect(observers[0]?.targets).toStrictEqual([element]);
        expect("paused" in element.dataset).toBe(false);

        report(false);

        expect("paused" in element.dataset).toBe(true);

        report(true);

        expect("paused" in element.dataset).toBe(false);

        unmount();

        expect(observers[0]?.disconnected).toBe(true);
    });

    it("keeps running where IntersectionObserver does not exist", () => {
        vi.stubGlobal("IntersectionObserver", undefined);
        const { element, unmount } = renderShimmer();

        expect("paused" in element.dataset).toBe(false);
        expect(element.classList.contains("animate-text-shimmer")).toBe(true);
        unmount();
    });
    it("does not pause a replacement element for its predecessor, when no observer can start for it", () => {
        vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
        const { current, element, rerender, unmount } = renderShimmer();

        report(false);

        expect("paused" in element.dataset).toBe(true);

        // Another element (`as` changed) while the observer can no longer start.
        vi.stubGlobal("IntersectionObserver", ThrowingObserver);
        rerender(<Shimmer as="span">Thinking...</Shimmer>);

        expect(current().tagName).toBe("SPAN");
        expect("paused" in current().dataset).toBe(false);
        unmount();
    });

    it("keeps running when IntersectionObserver throws on construction", () => {
        vi.stubGlobal("IntersectionObserver", ThrowingObserver);
        const { element, unmount } = renderShimmer();

        expect(element.textContent).toBe("Thinking...");
        expect("paused" in element.dataset).toBe(false);
        expect(element.classList.contains("animate-text-shimmer")).toBe(true);
        unmount();
    });

    it("keeps running under a stub that is not a constructor", () => {
        // Like the web test setup's `vi.fn().mockImplementation(() => ({ … }))`: an arrow implementation cannot be `new`-ed.
        vi.stubGlobal(
            "IntersectionObserver",
            vi.fn().mockImplementation(() => {
                return { disconnect: vi.fn(), observe: vi.fn() };
            }),
        );
        const { element, unmount } = renderShimmer();

        expect(element.textContent).toBe("Thinking...");
        expect(element.classList.contains("animate-text-shimmer")).toBe(true);
        unmount();
    });
});
