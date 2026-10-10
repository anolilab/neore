import env from "@/lib/env";

const TRAILING_SLASH_RE = /\/$/;

interface SeoOptions {
    description?: string;
    image?: string;
    keywords?: string;
    /** Set true for authenticated/private pages to suppress indexing */
    noIndex?: boolean;
    title: string;
    /** Page path (e.g. "/") or full URL. Used for og:url. */
    url?: string;
}

type MetaTag = { title: string } | { content: string; name: string } | { content: string; property: string };

/**
 * Generates meta descriptors for TanStack Router `head()`.
 * Covers basic SEO, Open Graph (property= attributes), and Twitter Card tags.
 */
export const seo = ({ description, image, keywords, noIndex = false, title, url }: SeoOptions): MetaTag[] => {
    const siteUrl = env.VITE_SITE_URL.replace(TRAILING_SLASH_RE, "");
    const appTitle = env.VITE_APP_TITLE ?? "Neore Chat";
    const pageTitle = title === appTitle ? appTitle : `${title} | ${appTitle}`;
    let canonicalUrl = siteUrl;

    if (url) {
        canonicalUrl = url.startsWith("http") ? url : `${siteUrl}${url}`;
    }

    return [
        { title: pageTitle },

        // Basic
        ...(description ? [{ content: description, name: "description" }] : []),
        ...(keywords ? [{ content: keywords, name: "keywords" }] : []),
        { content: noIndex ? "noindex, nofollow" : "index, follow", name: "robots" },

        // Open Graph — must use `property`, not `name`
        { content: "website", property: "og:type" },
        { content: appTitle, property: "og:site_name" },
        { content: pageTitle, property: "og:title" },
        { content: canonicalUrl, property: "og:url" },
        ...(description ? [{ content: description, property: "og:description" }] : []),
        ...(image ? [{ content: image, property: "og:image" }] : []),

        // Twitter Card
        { content: image ? "summary_large_image" : "summary", name: "twitter:card" },
        { content: pageTitle, name: "twitter:title" },
        ...(description ? [{ content: description, name: "twitter:description" }] : []),
        ...(image ? [{ content: image, name: "twitter:image" }] : []),
    ];
};

/**
 * Returns a script descriptor for JSON-LD structured data,
 * for use in the `scripts` array of TanStack Router's `head()`.
 * @example
 * head: () => ({
 *   scripts: [jsonLd({ "@context": "https://schema.org", "@type": "WebSite", ... })],
 * })
 */
export const jsonLd = (data: Record<string, unknown>): { children: string; type: string } => {
    return {
        children: JSON.stringify(data),
        type: "application/ld+json",
    };
};
