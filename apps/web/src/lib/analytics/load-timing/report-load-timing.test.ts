import { describe, expect, it } from "vitest";

import { LOAD_MARKS } from "../load-marks";
import { loadTimingProperties, routeSection } from "./report-load-timing";

describe(routeSection, () => {
    it.each([
        ["/chat/k57abc123def", "chat"],
        ["/settings/appearance", "settings"],
        ["/", "root"],
        ["/k57abc123def", "k57abc123def"],
        ["/%40someone", "root"],
    ])("reduces %s to %s", (pathname, expected) => {
        expect(routeSection(pathname)).toBe(expected);
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
            pathname: "/settings",
            vitals: {},
        });

        expect(properties.composer_visible_ms).toBe(1100);
        expect(properties.sidebar_list_visible_ms).toBeUndefined();
        expect(properties.lcp_ms).toBeUndefined();
    });
});
