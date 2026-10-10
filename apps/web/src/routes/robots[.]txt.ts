import { createFileRoute } from "@tanstack/react-router";

import env from "@/lib/env";

const TRAILING_SLASH_RE = /\/$/;

export const Route = createFileRoute("/robots.txt")({
    server: {
        handlers: {
            GET: async () => {
                const siteUrl = env.VITE_SITE_URL.replace(TRAILING_SLASH_RE, "");

                const content = [
                    "User-agent: *",
                    "Allow: /",
                    "Allow: /auth/sign-in",
                    "Allow: /auth/sign-up",
                    "Allow: /auth/forgot-password",
                    "Disallow: /dashboard/",
                    "Disallow: /chat/",
                    "Disallow: /workflow/",
                    "Disallow: /api/",
                    "Disallow: /_shortcut/",
                    "",
                    `Sitemap: ${siteUrl}/sitemap.xml`,
                ].join("\n");

                return new Response(content, {
                    headers: {
                        "Cache-Control": "public, max-age=86400",
                        "Content-Type": "text/plain; charset=utf-8",
                    },
                });
            },
        },
    },
});
