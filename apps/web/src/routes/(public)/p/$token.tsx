import { msg } from "@lingui/core/macro";
import { api } from "@neore/backend/api";
import { createFileRoute } from "@tanstack/react-router";

import type { PublicPage } from "@/features/pages/components/public-page-view";
import PublicPageView from "@/features/pages/components/public-page-view";
import { createLunoraActionQueryOptions } from "@/lib/lunora/crpc";
import { seo } from "@/lib/seo";

interface SharedPageLoaderData {
    description: string;
    page: PublicPage | null;
    status: "error" | "ok" | "unavailable";
    title: string;
}

const SharedPageRoute = () => {
    const { page, status } = Route.useLoaderData();

    return <PublicPageView page={page} status={status} />;
};

export const Route = createFileRoute("/(public)/p/$token")({
    component: SharedPageRoute,
    staleTime: 60_000,
    loader: async ({ context, params }): Promise<SharedPageLoaderData> => {
        const { i18n } = context;
        const description = i18n._(msg`A page shared from Neore.`);

        try {
            const page = await context.queryClient.fetchQuery(
                createLunoraActionQueryOptions(context.lunoraClient, api.pages.sharing.getPublicPage, { publicAccessToken: params.token }),
            );

            if (!page) {
                return { description, page: null, status: "unavailable", title: i18n._(msg`Page not available`) };
            }

            return { description, page, status: "ok", title: page.title || i18n._(msg`Shared page`) };
        } catch {
            return { description, page: null, status: "error", title: i18n._(msg`Shared page`) };
        }
    },
    head: ({ loaderData, match }) => {
        return {
            // Like `/thread/$token`: the link is a bearer credential, so no
            // canonical, no og:url, and noindex.
            meta: seo({
                description: loaderData?.description,
                noIndex: true,
                title: loaderData?.title ?? match.context.i18n._(msg`Shared page`),
            }),
        };
    },
});
