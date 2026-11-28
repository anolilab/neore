// eslint-disable-next-line testing-library/no-manual-cleanup -- vitest runs without globals, so nothing else cleans up between tests
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { usePageManifestLink } from "./use-page-manifest-link";

const mountManifestLink = (): HTMLLinkElement => {
    const link = document.createElement("link");

    link.rel = "manifest";
    link.setAttribute("href", "/manifest.json");
    document.head.appendChild(link);

    return link;
};

afterEach(() => {
    cleanup();
    document.head.replaceChildren();
});

describe("usePageManifestLink", () => {
    it("points the existing manifest link at the page's manifest while mounted, and restores it on unmount", () => {
        const link = mountManifestLink();
        const { unmount } = renderHook(() => {
            usePageManifestLink("page_1");
        });

        expect(link.getAttribute("href")).toBe("/page-manifest/page_1");

        unmount();

        expect(link.getAttribute("href")).toBe("/manifest.json");
    });

    it("moves to the new page when the page id changes, and restores the app's manifest at the end", () => {
        const link = mountManifestLink();
        const { rerender, unmount } = renderHook(
            ({ pageId }: { pageId: string }) => {
                usePageManifestLink(pageId);
            },
            { initialProps: { pageId: "page_1" } },
        );

        rerender({ pageId: "page_2" });
        expect(link.getAttribute("href")).toBe("/page-manifest/page_2");

        unmount();
        expect(link.getAttribute("href")).toBe("/manifest.json");
    });
});
