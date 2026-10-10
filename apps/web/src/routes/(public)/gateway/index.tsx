import { msg } from "@lingui/core/macro";
import { createFileRoute } from "@tanstack/react-router";

import GatewayLandingPage from "@/features/marketing/components/gateway-landing-page";
import env from "@/lib/env";
import { jsonLd, seo } from "@/lib/seo";

const TRAILING_SLASH_RE = /\/$/;

export const Route = createFileRoute("/(public)/gateway/")({
    component: GatewayLandingPage,
    head: ({ match }) => {
        const { i18n } = match.context;

        return {
            links: [{ href: `${env.VITE_SITE_URL.replace(TRAILING_SLASH_RE, "")}/gateway`, rel: "canonical" }],
            meta: seo({
                description: i18n._(
                    msg`Neore Gateway — unified LLM API for OpenAI, Google, Anthropic, xAI, Groq, and Mistral. Smart routing, automatic fallback, real-time usage tracking, and cost optimization. One API key, every model.`,
                ),
                image: `${env.VITE_SITE_URL.replace(TRAILING_SLASH_RE, "")}/og-gateway.png`,
                keywords:
                    "LLM gateway, AI API, unified API, OpenAI proxy, LLM proxy, smart routing, AI gateway, model routing, LLM cost optimization, AI infrastructure",
                title: i18n._(msg`Neore Gateway — Unified LLM API`),
                url: "/gateway",
            }),
            scripts: [
                jsonLd({
                    "@context": "https://schema.org",
                    "@type": "SoftwareApplication",
                    name: "Neore Gateway",
                    url: `${env.VITE_SITE_URL.replace(TRAILING_SLASH_RE, "")}/gateway`,
                    description: i18n._(
                        msg`Unified LLM API gateway with smart routing, automatic fallback, usage tracking, and cost optimization for OpenAI, Google, Anthropic, and more.`,
                    ),
                    applicationCategory: "DeveloperApplication",
                    operatingSystem: "Web",
                    offers: {
                        "@type": "Offer",
                        price: "0",
                        priceCurrency: "USD",
                    },
                }),
            ],
        };
    },
});
