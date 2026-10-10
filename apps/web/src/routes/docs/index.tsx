import { useLingui } from "@lingui/react/macro";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useFumadocsLoader } from "fumadocs-core/source/client";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { Suspense } from "react";

import docsClientLoader from "@/lib/docs-client-loader";
// Static import — TanStack Start's Vite plugin tree-shakes this from the client bundle
// because it's only referenced inside a createServerFn handler.
import docsSource from "@/lib/source";

// index.mdx is the root page of the docs section — its fumadocs slug is [] (empty array).
const serverIndexLoader = createServerFn({ method: "GET" }).handler(async () => {
    const page = docsSource.getPage([]);

    if (!page) {
        throw notFound();
    }

    return {
        path: page.path,
        pageTree: await docsSource.serializePageTree(docsSource.getPageTree()),
    };
});

const DocsIndexComponent = () => {
    const { t } = useLingui();
    const { path, pageTree } = useFumadocsLoader(Route.useLoaderData());

    return (
        <DocsLayout nav={{ title: t`Documentation` }} tree={pageTree}>
            <Suspense>{docsClientLoader.useContent(path)}</Suspense>
        </DocsLayout>
    );
};

export const Route = createFileRoute("/docs/")({
    loader: async () => {
        const data = await serverIndexLoader();

        // Dynamic, so the loader (which is not code-split) does not pull fumadocs onto every route.
        const { default: loader } = await import("@/lib/docs-client-loader");

        await loader.preload(data.path);

        return data;
    },
    component: DocsIndexComponent,
});
