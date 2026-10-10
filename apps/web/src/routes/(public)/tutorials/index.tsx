import { msg } from "@lingui/core/macro";
import { createFileRoute } from "@tanstack/react-router";

import TutorialsPage from "@/features/marketing/components/tutorials-page";
import env from "@/lib/env";
import { jsonLd, seo } from "@/lib/seo";

const TRAILING_SLASH_RE = /\/$/;

export const Route = createFileRoute("/(public)/tutorials/")({
    component: TutorialsPage,
    head: ({ match }) => {
        const { i18n } = match.context;
        const url = `${env.VITE_SITE_URL.replace(TRAILING_SLASH_RE, "")}/tutorials`;

        return {
            links: [{ href: url, rel: "canonical" }],
            meta: seo({
                description: i18n._(
                    msg`Learn how to use Neore Chat with step-by-step tutorials. From your first conversation to advanced AI features, automation, and integrations.`,
                ),
                image: `${env.VITE_SITE_URL.replace(TRAILING_SLASH_RE, "")}/og.png`,
                keywords: "Neore tutorials, AI chat tutorials, how to use AI, AI assistant guide, Neore guide, getting started AI chat",
                title: i18n._(msg`Tutorials — Learn Neore Chat | Neore`),
                url: "/tutorials",
            }),
            scripts: [
                jsonLd({
                    "@context": "https://schema.org",
                    "@type": "CollectionPage",
                    description: i18n._(msg`Step-by-step tutorials for getting the most out of Neore Chat`),
                    name: i18n._(msg`Neore Chat Tutorials`),
                    url,
                }),
            ],
        };
    },
});
