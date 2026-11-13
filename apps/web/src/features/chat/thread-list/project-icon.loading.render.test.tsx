// @vitest-environment jsdom
/* eslint-disable testing-library/no-container, testing-library/no-node-access -- which icon is drawn shows only in the svg's lucide class; the icons are aria-hidden */

/**
 * How a project icon behaves around the icon map's download: a name that cannot be a lucide name shows the folder at
 * once and downloads nothing, and a failed download shows the folder, then loads again when the page is visible again.
 */
// eslint-disable-next-line testing-library/no-manual-cleanup -- vitest runs without globals, so nothing else cleans up between tests
import { act, cleanup, render, waitFor } from "@testing-library/react";
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

        const { container } = render(<ProjectIcon color="#ff0000" name="rocket" />);

        await waitFor(() => {
            expect(container.querySelector("svg.lucide-folder")).not.toBeNull();
        });
        expect(loader.calls).toBe(1);

        loader.fail = false;
        act(() => {
            setVisibility("visible");
        });

        await waitFor(() => {
            expect(container.querySelector("svg.lucide-rocket")).not.toBeNull();
        });
        expect(loader.calls).toBe(2);
    });
});
