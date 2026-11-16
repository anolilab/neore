import { createFileRoute, notFound } from "@tanstack/react-router";

import { getUseCase } from "@/features/marketing/use-cases/use-case-data";
import { UseCasePage } from "@/features/marketing/use-cases/use-case-page";
import env from "@/lib/env";
import { jsonLd, seo } from "@/lib/seo";

const TRAILING_SLASH_RE = /\/$/;

const UseCaseRoute = () => {
    const { useCase } = Route.useLoaderData();

    return <UseCasePage useCase={useCase} />;
};

export const Route = createFileRoute("/(public)/use-cases/$useCaseSlug")({
    component: UseCaseRoute,
    loader: ({ params }) => {
        const useCase = getUseCase(params.useCaseSlug);

        if (!useCase) {
            throw notFound();
        }

        return { useCase };
    },
    head: ({ loaderData, match }) => {
        if (!loaderData) {
            return {};
        }

        const { i18n } = match.context;
        const { useCase } = loaderData;
        const base = env.VITE_SITE_URL.replace(TRAILING_SLASH_RE, "");
        const path = `/use-cases/${useCase.slug}`;

        return {
            links: [{ href: `${base}${path}`, rel: "canonical" }],
            meta: seo({
                description: i18n._(useCase.seoDescription),
                image: `${base}/og.png`,
                keywords: "Neore use cases, AI agent, AI assistant, automation",
                title: i18n._(useCase.seoTitle),
                url: path,
            }),
            scripts: [
                jsonLd({
                    "@context": "https://schema.org",
                    "@type": "WebPage",
                    description: i18n._(useCase.seoDescription),
                    name: i18n._(useCase.title),
                    url: `${base}${path}`,
                }),
            ],
        };
    },
});
