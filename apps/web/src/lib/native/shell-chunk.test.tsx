import { act, render, screen } from "@testing-library/react";
import type { ComponentType, JSX } from "react";
import { Suspense } from "react";
import { describe, expect, it, vi } from "vitest";

import { lazyShellChunk } from "./shell-chunk";

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
    const LazyBridge = lazyShellChunk(load, 3, 1);

    // No error boundary: a rejected chunk would reach the root and unmount the app.
    render(
        <div data-testid="app">
            <span>app content</span>
            <Suspense fallback={null}>
                <LazyBridge />
            </Suspense>
        </div>,
    );
};

describe("a lazily loaded shell chunk", () => {
    it("renders nothing, and leaves the app mounted, when every load fails", async () => {
        const load = flakyChunk(Infinity);

        renderShellChunk(load);

        // The three retries wait 1, 2 and 4 ms here; inside act, React renders the factory's result.
        await act(async () => {
            await new Promise<void>((resolve) => {
                setTimeout(resolve, 50);
            });
        });

        expect(load).toHaveBeenCalledTimes(4);
        expect(screen.getByText("app content")).toBeTruthy();
        expect(screen.getByTestId("app").childNodes).toHaveLength(1);
    });

    it("mounts the bridge when a load succeeds after two failures", async () => {
        const load = flakyChunk(2);

        renderShellChunk(load);

        expect(await screen.findByText("bridge mounted")).toBeTruthy();
        expect(load).toHaveBeenCalledTimes(3);
    });
});
