import { afterEach, describe, expect, it, vi } from "vitest";

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
    afterEach(() => {
        vi.restoreAllMocks();
        vi.resetModules();
        trackEvent.mockReset();
        Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    });

    const loadReporter = async () => await import("./report-load-timing");

    it("sends at once when the page was hidden before it started", async () => {
        Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });

        const { reportLoadTiming } = await loadReporter();

        reportLoadTiming();

        expect(trackEvent).toHaveBeenCalledOnce();
        expect(trackEvent).toHaveBeenCalledWith("page_load_timing", expect.objectContaining({ route_section: "root" }));
    });

    it("names the section the page was loaded at, not where a client-side navigation took it since", async () => {
        const getEntriesByType = performance.getEntriesByType.bind(performance);

        const loadedAt = [{ name: `${globalThis.location.origin}/chat/k57abc123def`, responseStart: 0 }] as unknown as PerformanceEntryList;

        vi.spyOn(performance, "getEntriesByType").mockImplementation(((type: string) =>
            type === "navigation" ? loadedAt : getEntriesByType(type)) as typeof performance.getEntriesByType);
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
