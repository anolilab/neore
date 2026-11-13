/**
 * Real-user load timing: one `page_load_timing` event per page load, with the Core Web Vitals and the app's own
 * load marks (`../load-marks.ts`).
 *
 * Loaded with a dynamic import when the analytics provider mounts, alongside PostHog's own chunk
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
    /** When the page was first hidden, if it was; 0 for a load that started hidden. A frame-timed mark after it holds the reveal. */
    firstHiddenAt: number | undefined;
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

/**
 * The event's properties. A mark recorded after the user's first input timed an interaction, and one recorded after the
 * page was first hidden timed the reveal (frames do not run in a hidden tab), so both are left out.
 */
export const loadTimingProperties = ({ firstHiddenAt, firstInputAt, marks, navigationType, pathname, vitals }: LoadTimingInput): PageLoadTimingProperties => {
    const cutoff = Math.min(firstInputAt ?? Infinity, firstHiddenAt ?? Infinity);
    const loadMark = (name: string): number | undefined => {
        const at = marks[name];

        return at !== undefined && at <= cutoff ? Math.round(at) : undefined;
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

/**
 * Watch `type` from navigation start (buffered). `flush` hands over what the browser has not delivered yet, so a send
 * right after starting still sees the buffered entries.
 */
const watchEntries = (type: string, onEntries: (entries: PerformanceEntryList) => void): (() => void) => {
    try {
        const observer = new PerformanceObserver((list) => {
            onEntries(list.getEntries());
        });

        observer.observe({ buffered: true, type });

        return () => {
            onEntries(observer.takeRecords());
        };
    } catch {
        // No PerformanceObserver, or this entry type is not supported here.
        return () => undefined;
    }
};

/** The navigation type, spelled as web-vitals does, for a send that comes before web-vitals reported. */
const entryNavigationType = (navigation: PerformanceNavigationTiming | undefined): string | undefined => navigation?.type.replaceAll("_", "-");

export interface ReportLoadTimingOptions {
    /** A `pagehide` came before this started (`providers/analytics-provider.tsx`): send now, the page is going away. */
    exited?: boolean;

    /**
     * When the provider first saw the page hidden (`performance.now()`); 0 when it was hidden at mount. Safari and Firefox
     * keep no `visibility-state` entries, so this is what tells a returning tab's load marks from its reveal.
     */
    firstHiddenAt?: number;

    /** The provider saw the page visible, at mount or since; a page never shown (a background tab) waits until it is. */
    hasBeenVisible?: boolean;
}

/**
 * Start collecting; the event is sent the first time the page is hidden (tab switch, close, navigation away) after it
 * has been visible. Started on a page that was shown and then hidden (or left) in the meantime, it sends at once; a page
 * that has never been visible (a tab opened in the background) waits until it has been.
 */
export const reportLoadTiming = ({ exited = false, firstHiddenAt: seenHiddenAt, hasBeenVisible: seenVisible = false }: ReportLoadTimingOptions = {}): void => {
    if (reporter.started) {
        return;
    }

    reporter.started = true;

    const pathname = loadedPathname();
    const visibilityEntries = performance.getEntriesByType("visibility-state");
    // The provider's record first; the `visibility-state` entries (Chromium) and the current state add to it.
    let hasBeenVisible = seenVisible || document.visibilityState === "visible" || visibilityEntries.some((entry) => entry.name === "visible");
    const hiddenAtStart = document.visibilityState === "hidden" && !hasBeenVisible ? 0 : undefined;
    let firstHiddenAt: number | undefined = seenHiddenAt ?? visibilityEntries.find((entry) => entry.name === "hidden")?.startTime ?? hiddenAtStart;

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

    // Read directly as well: web-vitals reports through callbacks that have not run when the page is already hidden.
    let firstInputAt: number | undefined;
    let latestPaint: number | undefined;
    const flushInputs = watchEntries("first-input", (entries) => {
        for (const entry of entries) {
            firstInputAt = Math.min(firstInputAt ?? Infinity, entry.startTime);
        }
    });
    const flushPaints = watchEntries("largest-contentful-paint", (entries) => {
        latestPaint = entries.at(-1)?.startTime ?? latestPaint;
    });

    const onVisibility = (): void => {
        if (document.visibilityState === "visible") {
            hasBeenVisible = true;
        } else {
            firstHiddenAt ??= performance.now();
        }
    };

    let sent = false;
    const send = (event?: Event): void => {
        const leaving = exited || event?.type === "pagehide";

        if (sent || !hasBeenVisible || (!leaving && document.visibilityState !== "hidden")) {
            return;
        }

        sent = true;
        flushInputs();
        flushPaints();

        const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
        // Only what painted before the page was first hidden: a later paint is the reveal of a background tab.
        const beforeHidden = (at: number | undefined): number | undefined => (at !== undefined && at < (firstHiddenAt ?? Infinity) ? at : undefined);
        const firstPaint = performance.getEntriesByName("first-contentful-paint", "paint")[0]?.startTime;
        const entryVitals: Partial<Record<VitalName, number>> = {
            FCP: beforeHidden(firstPaint),
            LCP: beforeHidden(latestPaint),
            TTFB: navigation && navigation.responseStart > 0 ? navigation.responseStart : undefined,
        };

        trackEvent(
            "page_load_timing",
            loadTimingProperties({
                firstHiddenAt,
                firstInputAt,
                marks: readMarks(),
                navigationType: navigationType ?? entryNavigationType(navigation),
                pathname,
                // web-vitals' paints get the same cutoff: after a tab is revealed it can report a paint of the reveal.
                vitals: {
                    FCP: beforeHidden(vitals.FCP) ?? entryVitals.FCP,
                    INP: vitals.INP,
                    LCP: beforeHidden(vitals.LCP) ?? entryVitals.LCP,
                    TTFB: vitals.TTFB ?? entryVitals.TTFB,
                },
            }),
        );
    };

    // Before `send`: a hide records its time first. On `document`, in the bubble phase: web-vitals listens on `window` in
    // the capture phase, so LCP and INP are final before `send` runs.
    document.addEventListener("visibilitychange", onVisibility);
    document.addEventListener("visibilitychange", send);
    globalThis.addEventListener("pagehide", send);

    send();
};
