/**
 * Real-user load timing: one `page_load_timing` event per page load, with the Core Web Vitals and the app's own
 * load marks (`../load-marks.ts`).
 *
 * Loaded with a dynamic import once PostHog is set up and the browser is idle, or the page is hidden first
 * (`providers/analytics-provider.tsx`), so neither this file nor `web-vitals`
 * is in the first-load bundle. The browser buffers the paint, navigation and event-timing entries, so a late start
 * still sees the whole load.
 */
import type { Metric } from "web-vitals";
import { onFCP, onINP, onLCP, onTTFB } from "web-vitals";

import type { PageLoadTimingProperties } from "../events";
import { LOAD_MARKS } from "../load-marks";
import { trackEvent } from "../track";

type VitalName = "FCP" | "INP" | "LCP" | "TTFB";

export interface LoadTimingInput {
    /** When the user first clicked or typed, if they have; a mark after it belongs to an interaction, not the load. */
    firstInputAt: number | undefined;
    /** `performance.mark` start times by name. */
    marks: Partial<Record<string, number>>;
    navigationType: string | undefined;
    pathname: string;
    vitals: Partial<Record<VitalName, number>>;
}

/**
 * The app's static top-level path segments (`routeTree.gen.ts`; the test keeps them in step). Anything else (a
 * mistyped or guessed address, which can be a name) is reported as `other`.
 */
export const ROUTE_SECTIONS: ReadonlySet<string> = new Set([
    "admin",
    "api",
    "auth",
    "chat",
    "code",
    "dashboard",
    "datenschutz",
    "develop",
    "docs",
    "download",
    "evals",
    "gateway",
    "guest",
    "impressum",
    "invite",
    "models",
    "offline-shell",
    "p",
    "pages",
    "prompts",
    "skills",
    "tasks",
    "thread",
    "tutorials",
    "use-cases",
    "vault",
    "workflow",
]);

const roundMs = (value: number | undefined): number | undefined => (value === undefined ? undefined : Math.round(value));

/**
 * Only a known route's first path segment (`chat`, `dashboard`), never ids or names: a thread id or an unknown address
 * is the user's own data.
 */
export const routeSection = (pathname: string): string => {
    const segment = pathname.split("/").find((part) => part !== "");

    if (segment === undefined) {
        return "root";
    }

    return ROUTE_SECTIONS.has(segment) ? segment : "other";
};

/** The address the page was loaded at, not where a client-side navigation has taken it since. */
export const loadedPathname = (): string => {
    const navigation = performance.getEntriesByType("navigation")[0];

    if (navigation?.name) {
        try {
            return new URL(navigation.name).pathname;
        } catch {
            // Fall through to the current address.
        }
    }

    return globalThis.location.pathname;
};

/** The event's properties. A mark recorded after the user's first input timed an interaction, so it is left out. */
export const loadTimingProperties = ({ firstInputAt, marks, navigationType, pathname, vitals }: LoadTimingInput): PageLoadTimingProperties => {
    const loadMark = (name: string): number | undefined => {
        const at = marks[name];

        return at !== undefined && (firstInputAt === undefined || at <= firstInputAt) ? Math.round(at) : undefined;
    };

    return {
        composer_visible_ms: loadMark(LOAD_MARKS.composerVisible),
        fcp_ms: roundMs(vitals.FCP),
        inp_ms: roundMs(vitals.INP),
        lcp_ms: roundMs(vitals.LCP),
        navigation_type: navigationType,
        route_section: routeSection(pathname),
        sidebar_list_visible_ms: loadMark(LOAD_MARKS.sidebarListVisible),
        ttfb_ms: roundMs(vitals.TTFB),
    };
};

const readMarks = (): Partial<Record<string, number>> => {
    const marks: Partial<Record<string, number>> = {};

    for (const name of Object.values(LOAD_MARKS)) {
        marks[name] = performance.getEntriesByName(name, "mark")[0]?.startTime;
    }

    return marks;
};

// Once per page load; an object, so the reporter can flip it.
const reporter = { started: false };

/** The vitals read from the entries: web-vitals reports nothing for a page already hidden when it starts. */
const entryVitals = (): Partial<Record<VitalName, number>> => {
    const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;

    return {
        FCP: performance.getEntriesByName("first-contentful-paint", "paint")[0]?.startTime,
        TTFB: navigation && navigation.responseStart > 0 ? navigation.responseStart : undefined,
    };
};

/**
 * Start collecting; the event is sent the first time the page is hidden (tab switch, close, navigation away). Started
 * on a page that was hidden in the meantime, it sends at once.
 */
export const reportLoadTiming = (): void => {
    if (reporter.started) {
        return;
    }

    reporter.started = true;

    const pathname = loadedPathname();
    const vitals: Partial<Record<VitalName, number>> = {};
    let navigationType: string | undefined;
    const record = (metric: Metric): void => {
        vitals[metric.name as VitalName] = metric.value;
        navigationType ??= metric.navigationType;
    };

    onFCP(record);
    onLCP(record);
    onINP(record);
    onTTFB(record);

    let sent = false;
    const send = (event?: Event): void => {
        if (sent || (event?.type !== "pagehide" && document.visibilityState !== "hidden")) {
            return;
        }

        sent = true;
        trackEvent(
            "page_load_timing",
            loadTimingProperties({
                firstInputAt: performance.getEntriesByType("first-input")[0]?.startTime,
                marks: readMarks(),
                navigationType,
                pathname,
                vitals: { ...entryVitals(), ...vitals },
            }),
        );
    };

    // On `document`, in the bubble phase: web-vitals listens on `window` in the capture phase, so LCP and INP are
    // final before this runs.
    document.addEventListener("visibilitychange", send);
    globalThis.addEventListener("pagehide", send);

    // The page was hidden before this started (`providers/analytics-provider.tsx` starts it on that hide).
    send();
};
