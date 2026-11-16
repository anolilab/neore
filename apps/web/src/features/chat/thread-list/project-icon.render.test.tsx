// @vitest-environment jsdom
/* eslint-disable testing-library/no-container, testing-library/no-node-access -- which icon is drawn shows only in the svg's lucide class; the icons are aria-hidden */

/**
 * A project's icon is a lucide name picked at runtime. The icon map loads once as a
 * single chunk: a named icon renders, an unknown name falls back to the folder, and
 * a later mount renders from the loaded map without showing the placeholder again.
 */
// eslint-disable-next-line testing-library/no-manual-cleanup -- vitest runs without globals, so nothing else cleans up between tests
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import ProjectIcon from "./project-icon";

afterEach(() => {
    cleanup();
});

describe("ProjectIcon", () => {
    it("renders the named lucide icon", async () => {
        const { container } = render(<ProjectIcon color="#ff0000" name="rocket" />);

        await waitFor(() => {
            expect(container.querySelector("svg.lucide-rocket")).not.toBeNull();
        });

        expect(container.querySelector("svg")?.getAttribute("style")).toContain("color");
    });

    it("renders an aliased name", async () => {
        const { container } = render(<ProjectIcon color="#ff0000" name="alarm-check" />);

        await waitFor(() => {
            expect(container.querySelector("svg")).not.toBeNull();
        });

        expect(container.querySelector("svg.lucide-folder")).toBeNull();
    });

    it.each(["not-a-real-icon", "Rocket", "icon", "create-lucide-icon", ""])("falls back to the folder icon for %j", async (name: string) => {
        const { container } = render(<ProjectIcon color="#ff0000" name={name} />);

        await waitFor(() => {
            expect(container.querySelector("svg.lucide-folder")).not.toBeNull();
        });
    });

    it("renders at once on a later mount, once the icon map has loaded", async () => {
        const view = render(<ProjectIcon color="#ff0000" name="rocket" />);

        await waitFor(() => {
            expect(view.container.querySelector("svg.lucide-rocket")).not.toBeNull();
        });

        view.unmount();

        const { container } = render(<ProjectIcon color="#ff0000" name="anchor" />);

        // No waiting: the first render already shows the icon, not the placeholder.
        expect(container.querySelector("svg.lucide-anchor")).not.toBeNull();
    });
});
