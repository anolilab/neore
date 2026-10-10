import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { createFileRoute } from "@tanstack/react-router";

import ModelsPage from "@/features/marketing/components/models-page";
import { ALL_MODELS, IMAGE_MODELS, TEXT_MODELS, VIDEO_MODELS } from "@/features/marketing/data/models-data";
import env from "@/lib/env";
import { localizeModelDescription } from "@/lib/model-descriptions";
import { jsonLd, seo } from "@/lib/seo";

const TRAILING_SLASH_RE = /\/$/;

export const Route = createFileRoute("/(public)/models/")({
    component: ModelsPage,
    head: ({ match }) => {
        const { i18n } = match.context;
        const translate = (descriptor: MessageDescriptor) => i18n._(descriptor);
        const modelCount = ALL_MODELS.length;
        const textCount = TEXT_MODELS.length;
        const imageCount = IMAGE_MODELS.length;
        const videoCount = VIDEO_MODELS.length;
        const url = `${env.VITE_SITE_URL.replace(TRAILING_SLASH_RE, "")}/models`;

        const textModelNames = TEXT_MODELS.map((m) => m.name)
            .slice(0, 15)
            .join(", ")
            .slice(0, 80);

        return {
            links: [{ href: url, rel: "canonical" }],
            meta: seo({
                description: i18n._(
                    msg`Explore all ${modelCount}+ AI models on Neore — ${textModelNames}, image generation, video generation, and more. One subscription, every model.`,
                ),
                image: `${env.VITE_SITE_URL.replace(TRAILING_SLASH_RE, "")}/og.png`,
                keywords: `AI models, AI chat models, AI image generation models, AI video generation models, ${TEXT_MODELS.map((m) => m.name)
                    .slice(0, 10)
                    .join(", ")}, ${IMAGE_MODELS.map((m) => m.name)
                    .slice(0, 8)
                    .join(", ")}, AI art models 2025`,
                title: i18n._(msg`AI Models — ${textCount} Text, ${imageCount} Image & ${videoCount} Video Generation Models | Neore`),
                url: "/models",
            }),
            scripts: [
                jsonLd({
                    "@context": "https://schema.org",
                    "@type": "ItemList",
                    description: i18n._(msg`Complete list of ${modelCount} AI models available in Neore — text, image, and video generation`),
                    itemListElement: ALL_MODELS.map((model, index) => {
                        return {
                            "@type": "ListItem",
                            description: localizeModelDescription(model.desc, translate),
                            name: model.name,
                            position: index + 1,
                            url: `${env.VITE_SITE_URL.replace(TRAILING_SLASH_RE, "")}/models/${model.slug}`,
                        };
                    }),
                    name: i18n._(msg`AI Text, Image & Video Generation Models`),
                    numberOfItems: ALL_MODELS.length,
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
                                text: `Neore includes ${TEXT_MODELS.length} text/chat AI models including Claude, GPT-5, Gemini, DeepSeek R1, Grok, Qwen3, Kimi K2, Llama, GLM, and more. All available from one subscription without managing separate accounts.`,
                            },
                            name: "What AI text and chat models does Neore support?",
                        },
                        {
                            "@type": "Question",
                            acceptedAnswer: {
                                "@type": "Answer",
                                text: `Neore includes ${IMAGE_MODELS.length} image generation models from providers like Black Forest Labs (Flux), Google (Imagen), OpenAI (ChatGPT Image, DALL-E), ByteDance (Seedream), Ideogram, Recraft, Runway, and Kling. All available from one subscription.`,
                            },
                            name: "What AI image generation models does Neore support?",
                        },
                        {
                            "@type": "Question",
                            acceptedAnswer: {
                                "@type": "Answer",
                                text: `Neore includes ${VIDEO_MODELS.length} video generation models including Google Veo 3.1, OpenAI Sora 2, Kling 3.0, Runway Gen-4.5, Hailuo 2.3, ByteDance Seedance, and many more. All accessible with one Neore subscription.`,
                            },
                            name: "What AI video generation models does Neore support?",
                        },
                        {
                            "@type": "Question",
                            acceptedAnswer: {
                                "@type": "Answer",
                                text: "Yes. Neore's free tier includes 20 messages a day on a set of fast, low-cost models, no credit card required. Pro ($20/mo) unlocks every text, image and video model, or bring your own API key.",
                            },
                            name: "Can I use these AI models for free?",
                        },
                        {
                            "@type": "Question",
                            acceptedAnswer: {
                                "@type": "Answer",
                                text: "No. Neore provides a single account with access to all models through one subscription. You don't need separate accounts with Anthropic, OpenAI, Google, Runway, Black Forest Labs, or any other provider.",
                            },
                            name: "Do I need separate subscriptions for each AI model?",
                        },
                    ],
                }),
            ],
        };
    },
});
