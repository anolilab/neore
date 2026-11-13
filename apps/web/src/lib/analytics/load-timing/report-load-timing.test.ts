import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import routeTree from "../../../routeTree.gen.ts?raw";
import { LOAD_MARKS } from "../load-marks";
import { loadTimingProperties, ROUTE_SECTIONS, routeSection } from "./report-load-timing";

const trackEvent = vi.hoisted(() => vi.fn());

vi.mock(import("../track"), () => {
    return { trackEvent };
});
vi.mock(import("web-vitals"), () => {
    return { onFCP: vi.fn(), onINP: vi.fn(), onLCP: vi.fn(), onTTFB: vi.fn() };
});

describe(routeSection, () => {
    it.each([
        ["/chat/k57abc123def", "chat"],
        ["/dashboard/usage", "dashboard"],
        ["/", "root"],
        ["/k57abc123def", "other"],
        ["/alice", "other"],
        ["/%40someone", "other"],
    ])("reduces %s to %s", (pathname, expected) => {
        expect(routeSection(pathname)).toBe(expected);
    });

    it("knows every static top-level route segment of the route tree", () => {
        const fullPaths = routeTree.slice(routeTree.indexOf("interface FileRoutesByFullPath"));
        const block = fullPaths.slice(0, fullPaths.indexOf("\n}"));
        const segments = new Set(
            [...block.matchAll(/'\/([^'/]+)/g)].map((match) => match[1] as string).filter((segment) => !segment.startsWith("$") && !segment.includes(".")),
        );

        const byName = (a: string, b: string): number => a.localeCompare(b);

        expect([...ROUTE_SECTIONS].toSorted(byName)).toStrictEqual([...segments].toSorted(byName));
    });
});

describe("reportLoadTiming", () => {
    /** Entries the page "recorded", by type; `PerformanceObserver` hands the buffered ones over through `takeRecords`. */
    let entries: Record<string, Partial<PerformanceEntry & PerformanceNavigationTiming>[]> = {};

    const entriesOf = (type: string): PerformanceEntryList => (entries[type] ?? []) as PerformanceEntryList;
    // Only an observer sees these, never `performance.getEntriesByType`.
    const observerOnly = new Set(["first-input", "largest-contentful-paint"]);

    beforeEach(() => {
        entries = {};
        vi.spyOn(performance, "getEntriesByType").mockImplementation(((type: string) =>
            observerOnly.has(type) ? [] : entriesOf(type)) as typeof performance.getEntriesByType);
        vi.spyOn(performance, "getEntriesByName").mockImplementation(((name: string, type?: string) =>
            [...entriesOf(type ?? "mark")].filter((entry) => entry.name === name)) as typeof performance.getEntriesByName);
        vi.stubGlobal(
            "PerformanceObserver",
            class {
                private type = "";

                public observe({ type }: { type: string }): void {
                    this.type = type;
                }

                public takeRecords(): PerformanceEntryList {
                    return entriesOf(this.type);
                }
            },
        );
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        vi.resetModules();
        trackEvent.mockReset();
        Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    });

    const loadReporter = async () => await import("./report-load-timing");

    const setVisibility = (state: DocumentVisibilityState): void => {
        Object.defineProperty(document, "visibilityState", { configurable: true, value: state });
        document.dispatchEvent(new Event("visibilitychange"));
    };

    const sentProperties = (): Record<string, unknown> => trackEvent.mock.calls[0]?.[1] as Record<string, unknown>;

    it("sends at once when the page was shown and then hidden before it started", async () => {
        Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
        entries["visibility-state"] = [
            { name: "visible", startTime: 0 },
            { name: "hidden", startTime: 3000 },
        ];

        const { reportLoadTiming } = await loadReporter();

        reportLoadTiming();

        expect(trackEvent).toHaveBeenCalledOnce();
        expect(trackEvent).toHaveBeenCalledWith("page_load_timing", expect.objectContaining({ route_section: "root" }));
    });

    it("sends at once in a browser without visibility-state entries when the provider saw the page shown, then hidden", async () => {
        Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
        entries.mark = [
            { name: LOAD_MARKS.composerVisible, startTime: 800 },
            { name: LOAD_MARKS.sidebarListVisible, startTime: 4000 },
        ];

        const { reportLoadTiming } = await loadReporter();

        reportLoadTiming({ firstHiddenAt: 3000, hasBeenVisible: true });

        expect(trackEvent).toHaveBeenCalledOnce();
        // Painted before the tab switch counts; after it, frames held until the page was shown again.
        expect(sentProperties()).toMatchObject({ composer_visible_ms: 800, sidebar_list_visible_ms: undefined });
    });

    it("keeps a returning tab's marks from before its first hide, without visibility-state entries", async () => {
        // Shown at mount, hidden at 3000 while the chunk loaded, back in front when it arrived.
        entries.mark = [
            { name: LOAD_MARKS.composerVisible, startTime: 800 },
            { name: LOAD_MARKS.sidebarListVisible, startTime: 4000 },
        ];

        const { reportLoadTiming } = await loadReporter();

        reportLoadTiming({ firstHiddenAt: 3000, hasBeenVisible: true });
        vi.spyOn(performance, "now").mockReturnValue(10_000);
        setVisibility("hidden");

        expect(sentProperties()).toMatchObject({ composer_visible_ms: 800, sidebar_list_visible_ms: undefined });
    });

    it("drops a paint web-vitals reports after the first hide, keeping the buffered one from before it", async () => {
        entries["largest-contentful-paint"] = [{ name: "", startTime: 900 }];

        const { reportLoadTiming } = await loadReporter();
        const { onFCP, onLCP } = await import("web-vitals");

        // Hidden at 3000 while the chunk loaded, back in front when it arrived.
        reportLoadTiming({ firstHiddenAt: 3000, hasBeenVisible: true });
        vi.mocked(onLCP).mock.calls[0]?.[0]({ name: "LCP", navigationType: "navigate", value: 5000 } as Parameters<Parameters<typeof onLCP>[0]>[0]);
        vi.mocked(onFCP).mock.calls[0]?.[0]({ name: "FCP", navigationType: "navigate", value: 4500 } as Parameters<Parameters<typeof onFCP>[0]>[0]);
        setVisibility("hidden");

        expect(sentProperties()).toMatchObject({ fcp_ms: undefined, lcp_ms: 900 });
    });

    it("waits in a browser without visibility-state entries when the page was never shown", async () => {
        Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });

        const { reportLoadTiming } = await loadReporter();

        reportLoadTiming({ firstHiddenAt: 0, hasBeenVisible: false });

        expect(trackEvent).not.toHaveBeenCalled();

        setVisibility("visible");
        setVisibility("hidden");

        expect(trackEvent).toHaveBeenCalledOnce();
    });

    it("waits for a tab opened in the background to be shown, then hidden, before it sends", async () => {
        Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
        entries["visibility-state"] = [{ name: "hidden", startTime: 0 }];

        const { reportLoadTiming } = await loadReporter();

        reportLoadTiming();

        expect(trackEvent).not.toHaveBeenCalled();

        setVisibility("visible");
        setVisibility("hidden");

        expect(trackEvent).toHaveBeenCalledOnce();
    });

    it("leaves out the paint and the marks of a background tab, which hold when it was revealed", async () => {
        Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
        entries["visibility-state"] = [{ name: "hidden", startTime: 0 }];
        entries.paint = [{ name: "first-contentful-paint", startTime: 90_000 }];
        entries.mark = [{ name: LOAD_MARKS.composerVisible, startTime: 90_050 }];

        const { reportLoadTiming } = await loadReporter();

        reportLoadTiming();
        setVisibility("visible");
        setVisibility("hidden");

        expect(sentProperties()).toMatchObject({ composer_visible_ms: undefined, fcp_ms: undefined });
    });

    it("sends at once when the page was left before it started", async () => {
        const { reportLoadTiming } = await loadReporter();

        reportLoadTiming({ exited: true });

        expect(trackEvent).toHaveBeenCalledOnce();
    });

    it("leaves out a mark made after the first input, read from the buffered first-input entry", async () => {
        entries["first-input"] = [{ name: "pointerdown", startTime: 1000 }];
        entries.mark = [
            { name: LOAD_MARKS.composerVisible, startTime: 800 },
            { name: LOAD_MARKS.sidebarListVisible, startTime: 1500 },
        ];

        const { reportLoadTiming } = await loadReporter();

        reportLoadTiming();
        globalThis.dispatchEvent(new Event("pagehide"));

        expect(sentProperties()).toMatchObject({ composer_visible_ms: 800, sidebar_list_visible_ms: undefined });
    });

    it("sends the buffered LCP and the navigation type when it sends before web-vitals reported", async () => {
        entries.navigation = [{ name: `${globalThis.location.origin}/chat`, responseStart: 120, type: "back_forward" }];
        entries["largest-contentful-paint"] = [
            { name: "", startTime: 600 },
            { name: "", startTime: 950 },
        ];

        const { reportLoadTiming } = await loadReporter();

        reportLoadTiming({ exited: true });

        expect(sentProperties()).toMatchObject({ lcp_ms: 950, navigation_type: "back-forward", ttfb_ms: 120 });
    });

    it("names the section the page was loaded at, not where a client-side navigation took it since", async () => {
        entries.navigation = [{ name: `${globalThis.location.origin}/chat/k57abc123def`, responseStart: 0, type: "navigate" }];
        globalThis.history.pushState({}, "", "/dashboard");

        const { reportLoadTiming } = await loadReporter();

        reportLoadTiming();
        globalThis.dispatchEvent(new Event("pagehide"));

        expect(trackEvent).toHaveBeenCalledWith("page_load_timing", expect.objectContaining({ route_section: "chat" }));

        globalThis.history.pushState({}, "", "/");
    });
});

describe(loadTimingProperties, () => {
    const vitals = { FCP: 412.4, INP: 88, LCP: 980.6, TTFB: 120.2 };

    it("rounds the vitals and keeps marks painted before the first input", () => {
        expect(
            loadTimingProperties({
                firstHiddenAt: undefined,
                firstInputAt: 2000,
                marks: { [LOAD_MARKS.composerVisible]: 1100.7, [LOAD_MARKS.sidebarListVisible]: 1500.2 },
                navigationType: "reload",
                pathname: "/chat/k57abc123def",
                vitals,
            }),
        ).toStrictEqual({
            composer_visible_ms: 1101,
            fcp_ms: 412,
            inp_ms: 88,
            lcp_ms: 981,
            navigation_type: "reload",
            route_section: "chat",
            sidebar_list_visible_ms: 1500,
            ttfb_ms: 120,
        });
    });

    it("drops a mark recorded after the first input, which timed an interaction, not the load", () => {
        const properties = loadTimingProperties({
            firstHiddenAt: undefined,
            firstInputAt: 1200,
            marks: { [LOAD_MARKS.composerVisible]: 1100, [LOAD_MARKS.sidebarListVisible]: 5000 },
            navigationType: "navigate",
            pathname: "/dashboard",
            vitals: {},
        });

        expect(properties.composer_visible_ms).toBe(1100);
        expect(properties.sidebar_list_visible_ms).toBeUndefined();
        expect(properties.lcp_ms).toBeUndefined();
    });
});
