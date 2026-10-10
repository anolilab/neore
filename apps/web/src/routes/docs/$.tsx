import { useLingui } from "@lingui/react/macro";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useFumadocsLoader } from "fumadocs-core/source/client";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import type { CSSProperties } from "react";
import { Suspense } from "react";

import docsClientLoader from "@/lib/docs-client-loader";
// Static import — TanStack Start's Vite plugin tree-shakes this from the client bundle
// because it's only referenced inside a createServerFn handler.
import docsSource from "@/lib/source";

const serverLoader = createServerFn({ method: "GET" })
    .validator((slugs: string[]) => slugs)
    .handler(async ({ data: slugs }) => {
        const page = docsSource.getPage(slugs);

        if (!page) {
            throw notFound();
        }

        return {
            path: page.path,
            pageTree: await docsSource.serializePageTree(docsSource.getPageTree()),
        };
    });

const DocumentPageComponent = () => {
    const { t } = useLingui();
    const { path, pageTree } = useFumadocsLoader(Route.useLoaderData());

    return (
        <DocsLayout
            containerProps={{
                // Offset the sticky marketing navbar (h-14 = 3.5rem + 1px border-b)
                // so the fumadocs layout doesn't overflow and block page-level scrolling.
                style: { "--fd-docs-height": "calc(100dvh - 3.5rem - 1px)" } as CSSProperties,
            }}
            nav={{ title: t`Documentation` }}
            themeSwitch={{ enabled: false }}
            tree={pageTree}
        >
            <Suspense>{docsClientLoader.useContent(path)}</Suspense>
        </DocsLayout>
    );
};

export const Route = createFileRoute("/docs/$")({
    loader: async ({ params }) => {
        const slugs = params._splat?.split("/").filter(Boolean) ?? [];
        const data = await serverLoader({ data: slugs });

        // Dynamic, so the loader (which is not code-split) does not pull fumadocs onto every route.
        const { default: loader } = await import("@/lib/docs-client-loader");

        await loader.preload(data.path);

        return data;
    },
    component: DocumentPageComponent,
});
