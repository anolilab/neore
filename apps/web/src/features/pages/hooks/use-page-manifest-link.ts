import { useEffect } from "react";

import { MANIFEST_LINK_SELECTOR } from "@/features/download/lib/install-prompt-store";

import { pageManifestHref } from "../lib/page-manifest";

/**
 * While a page is mounted, points the document's manifest link at the page's own manifest, so the browser
 * offers an install of that page. The original href is restored on unmount, so the app's install is unchanged
 * elsewhere. The swap changes the link in place: a second link would be ignored, since the browser keeps the first.
 */
export const usePageManifestLink = (pageId: string): void => {
    useEffect(() => {
        const link = document.querySelector<HTMLLinkElement>(MANIFEST_LINK_SELECTOR);

        if (!link) {
            return undefined;
        }

        const originalHref = link.getAttribute("href") ?? "";

        link.setAttribute("href", pageManifestHref(pageId));

        return () => {
            link.setAttribute("href", originalHref);
        };
    }, [pageId]);
};
