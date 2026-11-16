// @vitest-environment jsdom
/* eslint-disable testing-library/no-container, testing-library/no-node-access -- which icon is drawn shows only in the svg's lucide class; the icons are aria-hidden */

/**
 * How a project icon behaves around the icon map's download: a name that cannot be a lucide name shows the folder at
 * once and downloads nothing, and a failed download shows the folder, then loads again when the page is visible again.
 */
// eslint-disable-next-line testing-library/no-manual-cleanup -- vitest runs without globals, so nothing else cleans up between tests
import { act, cleanup, render } from "@testing-library/react";
import { Rocket } from "lucide-react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import ProjectIcon from "./project-icon";

const { loader } = vi.hoisted(() => {
    return { loader: { calls: 0, fail: false } };
});

vi.mock("@neore/ui/components/lucide-icon-loader", async (importOriginal: () => Promise<Record<string, unknown>>) => {
    const actual = await importOriginal();

    return {
        ...actual,
        getLoadedLucideIconMap: () => undefined,
        loadLucideIconMap: async () => {
            loader.calls += 1;

            if (loader.fail) {
                throw new Error("chunk failed to load");
            }

            return (name: string) => (name === "rocket" ? Rocket : undefined);
        },
    };
});

const setVisibility = (state: DocumentVisibilityState): void => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: state });
    document.dispatchEvent(new Event("visibilitychange"));
};

/**
 * Runs `step` in an async act, which keeps flushing until nothing is queued: the effect that starts the download, the
 * download's `then`/`catch` update and the effects of that render (the retry listener) all run before it returns. With
 * the update made outside act, that listener could still be pending when the test dispatches `visibilitychange`.
 */
const settle = async (step: () => void): Promise<void> => {
    await act(async () => {
        step();
    });
};

beforeEach(() => {
    loader.calls = 0;
    loader.fail = false;
});

afterEach(() => {
    cleanup();
});

describe("ProjectIcon around the icon map's download", () => {
    it.each(["Rocket", "my icon", "", "-rocket"])("shows the folder at once for %j and downloads nothing", async (name: string) => {
        const { container } = render(<ProjectIcon color="#ff0000" name={name} />);

        // The first render already: no placeholder, no wait.
        expect(container.querySelector("svg.lucide-folder")).not.toBeNull();

        await act(async () => {
            await Promise.resolve();
        });

        expect(loader.calls).toBe(0);
    });

    it("shows the folder when the download fails, and loads again once the page is visible again", async () => {
        loader.fail = true;

        let container: HTMLElement = document.body;

        // render's own act is synchronous and returns before the failed download's update and its effects; the async
        // act in `settle` waits for both, so the retry listener is attached before the next step.
        await settle(() => {
            ({ container } = render(<ProjectIcon color="#ff0000" name="rocket" />));
        });

        expect(container.querySelector("svg.lucide-folder")).not.toBeNull();
        expect(loader.calls).toBe(1);

        loader.fail = false;
        await settle(() => {
            setVisibility("visible");
        });

        expect(container.querySelector("svg.lucide-rocket")).not.toBeNull();
        expect(loader.calls).toBe(2);
    });
});
