import { render, screen } from "@testing-library/react";
import type { ComponentType, JSX } from "react";
import { lazy, Suspense } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { retryChunk, SilentBoundary } from "./shell-chunk";

const Bridge = (): JSX.Element => <span>bridge mounted</span>;

/** A chunk fetch that rejects `failures` times, then resolves with the bridge. */
const flakyChunk = (failures: number): (() => Promise<{ default: ComponentType }>) => {
    let calls = 0;

    return vi.fn(async () => {
        calls += 1;

        if (calls <= failures) {
            throw new TypeError("Failed to fetch dynamically imported module");
        }

        return { default: Bridge };
    });
};

const renderShellChunk = (load: () => Promise<{ default: ComponentType }>): void => {
    const LazyBridge = lazy(async () => await retryChunk(load, 3, 1));

    render(
        <div data-testid="app">
            <SilentBoundary>
                <Suspense fallback={null}>
                    <LazyBridge />
                </Suspense>
            </SilentBoundary>
        </div>,
    );
};

describe("a lazily loaded shell chunk", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("renders nothing, without throwing, when every load fails", async () => {
        // React logs the caught error; the boundary is what keeps it from reaching the app.
        vi.spyOn(console, "error").mockImplementation(() => {});

        const load = flakyChunk(Infinity);

        renderShellChunk(load);

        await vi.waitFor(() => {
            expect(load).toHaveBeenCalledTimes(4);
        });
        await vi.waitFor(() => {
            expect(screen.getByTestId("app").childNodes).toHaveLength(0);
        });
    });

    it("mounts the bridge when a load succeeds after two failures", async () => {
        const load = flakyChunk(2);

        renderShellChunk(load);

        expect(await screen.findByText("bridge mounted")).toBeTruthy();
        expect(load).toHaveBeenCalledTimes(3);
    });
});
