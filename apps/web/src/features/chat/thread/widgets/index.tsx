"use client";

/**
 * Tool Widget Registry
 *
 * Maps tool names (matching ToolName enum values from backend/lunora/chat/tools/index.ts)
 * to lazy-loaded widget components. These are injected into the chat-ui
 * MessageContent via the `toolWidgets` prop.
 */

import type { FC } from "react";
import { lazy, memo, Suspense } from "react";

// Lazy-load all widgets to keep the initial bundle small
const LazyWeatherWidget = lazy(() => import("./weather-widget"));
const LazyCurrencyWidget = lazy(() => import("./currency-widget"));
const LazyFindPlaceWidget = lazy(() =>
    import("./places-widget").then((m) => {
        return { default: m.FindPlaceWidget };
    }),
);
const LazyNearbyPlacesWidget = lazy(() =>
    import("./places-widget").then((m) => {
        return { default: m.NearbyPlacesWidget };
    }),
);
const LazyStockWidget = lazy(() => import("./stock-widget"));
const LazyCryptoWidget = lazy(() => import("./crypto-widget"));
const LazyFlightWidget = lazy(() => import("./flight-widget"));
const LazyWolframWidget = lazy(() => import("./wolfram-widget"));
const LazyWebSearchResults = lazy(() => import("./web-search-results"));
const LazyImageSearchGallery = lazy(() => import("./image-search-gallery"));
const LazyVideoSearchResults = lazy(() => import("./video-search-results"));
const LazyGenerativeUIWidget = lazy(() => import("./generative-ui-widget"));

/** Wraps a lazy widget in Suspense with null fallback. */
const wrapLazy = <T extends object>(LazyComponent: FC<T>): FC<T> => {
    const Wrapped: FC<T> = memo((props) => (
        <Suspense fallback={null}>
            <LazyComponent {...props} />
        </Suspense>
    ));

    Wrapped.displayName = `LazyWidget(${LazyComponent.displayName || "Unknown"})`;

    return Wrapped;
};

/**
 * Registry mapping tool names to widget components.
 * Keys must match the ToolName enum values (e.g., "weather", "stockChart").
 * Each widget receives `{ output: unknown }` and is responsible for typing its own data.
 */
const TOOL_WIDGETS: Record<string, FC<{ output: unknown }>> = {
    coinData: wrapLazy(LazyCryptoWidget) as FC<{ output: unknown }>,
    coinDataByContract: wrapLazy(LazyCryptoWidget) as FC<{ output: unknown }>,

    // Finance
    currencyConverter: wrapLazy(LazyCurrencyWidget) as FC<{ output: unknown }>,
    // Location
    findPlace: wrapLazy(LazyFindPlaceWidget) as FC<{ output: unknown }>,
    // Travel
    flightTracker: wrapLazy(LazyFlightWidget) as FC<{ output: unknown }>,
    imageSearch: wrapLazy(LazyImageSearchGallery) as FC<{ output: unknown }>,

    nearbyPlacesSearch: wrapLazy(LazyNearbyPlacesWidget) as FC<{ output: unknown }>,
    // Generative UI
    renderUI: wrapLazy(LazyGenerativeUIWidget) as FC<{ output: unknown }>,

    stockChart: wrapLazy(LazyStockWidget) as FC<{ output: unknown }>,

    videoSearch: wrapLazy(LazyVideoSearchResults) as FC<{ output: unknown }>,
    // Information
    weather: wrapLazy(LazyWeatherWidget) as FC<{ output: unknown }>,
    // Search
    webSearch: wrapLazy(LazyWebSearchResults) as FC<{ output: unknown }>,

    wolframAlpha: wrapLazy(LazyWolframWidget) as FC<{ output: unknown }>,
};

export default TOOL_WIDGETS;
