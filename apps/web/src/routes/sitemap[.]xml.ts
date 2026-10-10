import { createFileRoute } from "@tanstack/react-router";

import env from "@/lib/env";

const TRAILING_SLASH_RE = /\/$/;

/** Public routes indexed in the sitemap. Authenticated routes are excluded. */
const PUBLIC_ROUTES: { changefreq: string; path: string; priority: string }[] = [
    { changefreq: "weekly", path: "/", priority: "1.0" },
    { changefreq: "monthly", path: "/auth/sign-in", priority: "0.8" },
    { changefreq: "monthly", path: "/auth/sign-up", priority: "0.8" },
    { changefreq: "monthly", path: "/auth/forgot-password", priority: "0.4" },
];

const buildSitemap = (baseUrl: string): string => {
    const today = new Date().toISOString().split("T", 1)[0];

    const urls = PUBLIC_ROUTES.map(
        ({ changefreq, path, priority }) =>
            `  <url>\n    <loc>${baseUrl}${path}</loc>\n    <lastmod>${today}</lastmod>\n    <changefreq>${changefreq}</changefreq>\n    <priority>${priority}</priority>\n  </url>`,
    ).join("\n");

    return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>`;
};

export const Route = createFileRoute("/sitemap.xml")({
    server: {
        handlers: {
            GET: async () => {
                const baseUrl = env.VITE_SITE_URL.replace(TRAILING_SLASH_RE, "");

                return new Response(buildSitemap(baseUrl), {
                    headers: {
                        "Cache-Control": "public, max-age=3600",
                        "Content-Type": "application/xml; charset=utf-8",
                    },
                });
            },
        },
    },
});
