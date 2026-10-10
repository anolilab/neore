import { msg } from "@lingui/core/macro";
import { createFileRoute, notFound } from "@tanstack/react-router";

import ModelDetailPage from "@/features/marketing/components/model-detail-page";
import type { MarketingModel } from "@/features/marketing/data/models-data";
import { ALL_MODELS, getModelBySlug } from "@/features/marketing/data/models-data";
import env from "@/lib/env";
import { localizeModelDescription } from "@/lib/model-descriptions";
import { jsonLd, seo } from "@/lib/seo";

const TRAILING_SLASH_RE = /\/$/;

interface ModelDetailLoaderData {
    model: MarketingModel;
    seo: { bestFor: string; strengths: string[]; tags: string[] };
}

const ModelDetailPageWrapper = () => {
    const { model } = Route.useLoaderData();

    return <ModelDetailPage model={model} />;
};

export const Route = createFileRoute("/(public)/models/$modelSlug")({
    component: ModelDetailPageWrapper,
    loader: ({ context, params }): ModelDetailLoaderData => {
        const model = getModelBySlug(params.modelSlug);

        if (!model) {
            throw notFound();
        }

        // The SEO copy is a set of Lingui descriptors; <head> has no i18n of
        // its own, so it is resolved here, like `/thread/$token` does.
        const { i18n } = context;

        return {
            model,
            seo: {
                bestFor: i18n._(model.bestFor),
                strengths: model.strengths.map((strength) => i18n._(strength)),
                tags: model.tags.map((tag) => i18n._(tag)),
            },
        };
    },
    head: ({ loaderData, match }) => {
        if (!loaderData) {
            return {};
        }

        const { i18n } = match.context;
        const { model, seo: modelSeo } = loaderData;
        const url = `${env.VITE_SITE_URL.replace(TRAILING_SLASH_RE, "")}/models/${model.slug}`;
        const totalModels = ALL_MODELS.length;
        const { name } = model;
        const description = localizeModelDescription(model.desc, (descriptor) => i18n._(descriptor));

        let modeLabel = "AI Text Generation";
        let category = "ConversationalAIApplication";
        // Interpolated through a member expression, as in `ModelDetailPage`, so
        // the FAQ below shares that page's positional `{1}` catalog entries.
        const copy = { comparisonNoun: "text" };
        let pageTitle = i18n._(msg`${name} — AI Text Generation Model | Neore`);
        let pageDescription = i18n._(msg`${name} — ${description}. Available on Neore with ${totalModels}+ other AI text generation models. Try it free.`);

        if (model.mode === "image") {
            modeLabel = "AI Image Generation";
            category = "ImageGenerationApplication";
            copy.comparisonNoun = "image generation";
            pageTitle = i18n._(msg`${name} — AI Image Generation Model | Neore`);
            pageDescription = i18n._(msg`${name} — ${description}. Available on Neore with ${totalModels}+ other AI image generation models. Try it free.`);
        } else if (model.mode === "video") {
            modeLabel = "AI Video Generation";
            category = "VideoGenerationApplication";
            copy.comparisonNoun = "video generation";
            pageTitle = i18n._(msg`${name} — AI Video Generation Model | Neore`);
            pageDescription = i18n._(msg`${name} — ${description}. Available on Neore with ${totalModels}+ other AI video generation models. Try it free.`);
        }

        return {
            links: [{ href: url, rel: "canonical" }],
            meta: seo({
                description: pageDescription,
                image: `${env.VITE_SITE_URL.replace(TRAILING_SLASH_RE, "")}/og.png`,
                // Search keywords stay English, like every other route's.
                keywords: `${model.name}, ${model.provider}, ${modeLabel}, ${modelSeo.tags.join(", ")}, AI models, Neore`,
                title: pageTitle,
                url: `/models/${model.slug}`,
            }),
            scripts: [
                jsonLd({
                    "@context": "https://schema.org",
                    "@type": "SoftwareApplication",
                    applicationCategory: category,
                    description,
                    name: model.name,
                    offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
                    operatingSystem: "Web",
                    url,
                }),
                jsonLd({
                    "@context": "https://schema.org",
                    "@type": "FAQPage",
                    mainEntity: [
                        {
                            "@type": "Question",
                            acceptedAnswer: {
                                "@type": "Answer",
                                text: i18n._(
                                    msg`Neore's free tier gives you 20 messages a day on a set of fast, low-cost models, no credit card required. Pro ($20/mo) unlocks ${model.name} and all ${totalModels}+ models, or bring your own API key for its provider.`,
                                ),
                            },
                            name: i18n._(msg`Is ${model.name} free to use?`),
                        },
                        {
                            "@type": "Question",
                            acceptedAnswer: {
                                "@type": "Answer",
                                text: modelSeo.bestFor,
                            },
                            name: i18n._(msg`What is ${model.name} best for?`),
                        },
                        {
                            "@type": "Question",
                            acceptedAnswer: {
                                "@type": "Answer",
                                text: i18n._(
                                    msg`${model.name} by ${model.provider} stands out for: ${modelSeo.strengths.join("; ")}. On Neore you can compare it side-by-side with ${totalModels - 1} other models in the same conversation thread.`,
                                ),
                            },
                            name: i18n._(msg`How does ${model.name} compare to other ${copy.comparisonNoun} models?`),
                        },
                        {
                            "@type": "Question",
                            acceptedAnswer: {
                                "@type": "Answer",
                                text: i18n._(
                                    msg`No. Neore provides direct API access to ${model.name} and every other model through a single account. One login, one subscription — no need to manage accounts with ${model.provider} or any other provider separately.`,
                                ),
                            },
                            name: i18n._(msg`Do I need a separate ${model.provider} account to use ${model.name}?`),
                        },
                    ],
                }),
            ],
        };
    },
});
