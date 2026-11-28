const PAGE_ID_PATTERN = /^[\w-]{1,128}$/u;

/**
 * A page id is only ever a URL segment. Row ids are Lunora UUIDs, but an imported page keeps its source id, which need not
 * be a UUID, so the check is the segment alphabet rather than a UUID shape. Anything else is refused, never echoed back.
 */
export const isPageId = (pageId: string): boolean => PAGE_ID_PATTERN.test(pageId);

export interface PageManifest {
    background_color: string;
    display: "standalone";
    icons: { sizes: string; src: string; type: string }[];
    id: string;
    name: string;
    scope: string;
    short_name: string;
    start_url: string;
    theme_color: string;
}

/** The app path of a page. It is also the manifest's `id`, `start_url` and `scope`. */
export const pagePath = (pageId: string): string => `/pages/${pageId}`;

/** The manifest href a page's install uses. The route serving it is `routes/page-manifest/$pageId.ts`. */
export const pageManifestHref = (pageId: string): string => `/page-manifest/${pageId}`;

/**
 * The web app manifest for one page's own app window. Built from constants and the id in the URL only:
 * no title, no user data, no session. Every page gets the same name, so the page's title stays private.
 */
export const buildPageManifest = (pageId: string): PageManifest | undefined => {
    if (!isPageId(pageId)) {
        return undefined;
    }

    const path = pagePath(pageId);

    return {
        background_color: "#212121",
        display: "standalone",
        icons: [
            { sizes: "192x192", src: "/pwa-icon-192x192.png", type: "image/png" },
            { sizes: "512x512", src: "/pwa-icon-512x512.png", type: "image/png" },
        ],
        id: path,
        name: "Neore page",
        scope: path,
        short_name: "Neore page",
        start_url: path,
        theme_color: "#191919",
    };
};
