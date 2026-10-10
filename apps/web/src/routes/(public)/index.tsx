import { msg } from "@lingui/core/macro";
import { createFileRoute } from "@tanstack/react-router";

import LandingPage from "@/features/marketing/components/landing-page";
import env from "@/lib/env";
import { jsonLd, seo } from "@/lib/seo";

const TRAILING_SLASH_RE = /\/$/;

export const Route = createFileRoute("/(public)/")({
    // Deliberately ungated. This is the marketing landing page — hero, "Try it
    // free", a Login link, a canonical tag, an OG image and a JSON-LD
    // WebApplication block — and `sitemap.xml` lists it at priority 1.0.
    //
    // 29c67458 gated it on `context.isAuthenticated`, which meant no anonymous
    // visitor and no crawler ever reached it: every one of them was answered
    // with a 307 to /auth/sign-in, and all of the SEO above became unreachable
    // markup. Its siblings in this route group (/models, /tutorials) were never
    // gated, so this was the odd one out rather than a group-wide policy.
    component: LandingPage,
    head: ({ match }) => {
        const { i18n } = match.context;

        return {
            links: [{ href: env.VITE_SITE_URL, rel: "canonical" }],
            meta: seo({
                description: i18n._(
                    msg`Neore Chat is a modern AI chat application. Chat with the latest models — Claude, GPT, Gemini and more — in one place. Organised conversations, document canvas, and deep research tools.`,
                ),
                image: `${env.VITE_SITE_URL.replace(TRAILING_SLASH_RE, "")}/og.png`,
                keywords: "AI chat, Claude, ChatGPT, Gemini, AI assistant, AI models, productivity, chat app",
                title: "Neore Chat",
                url: "/",
            }),
            scripts: [
                jsonLd({
                    "@context": "https://schema.org",
                    "@type": "WebApplication",
                    name: "Neore Chat",
                    url: env.VITE_SITE_URL,
                    description: i18n._(
                        msg`A modern AI chat application supporting Claude, GPT, Gemini and more with document canvas, deep research, and workflow tools.`,
                    ),
                    applicationCategory: "ProductivityApplication",
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
