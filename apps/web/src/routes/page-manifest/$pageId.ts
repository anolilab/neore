import { createFileRoute } from "@tanstack/react-router";

import { buildPageManifest } from "@/features/pages/lib/page-manifest";

export const Route = createFileRoute("/page-manifest/$pageId")({
    server: {
        handlers: {
            GET: ({ params }) => {
                const manifest = buildPageManifest(params.pageId);

                if (!manifest) {
                    return new Response("Not found", { status: 404 });
                }

                return Response.json(manifest, {
                    headers: {
                        "Cache-Control": "public, max-age=86400",
                        "Content-Type": "application/manifest+json; charset=utf-8",
                    },
                });
            },
        },
    },
});
