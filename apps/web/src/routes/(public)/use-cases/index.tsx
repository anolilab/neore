import { msg } from "@lingui/core/macro";
import { createFileRoute } from "@tanstack/react-router";

import { UseCasesIndexPage } from "@/features/marketing/use-cases/use-cases-index-page";
import env from "@/lib/env";
import { jsonLd, seo } from "@/lib/seo";

const TRAILING_SLASH_RE = /\/$/;

export const Route = createFileRoute("/(public)/use-cases/")({
    component: UseCasesIndexPage,
    head: ({ match }) => {
        const { i18n } = match.context;
        const url = `${env.VITE_SITE_URL.replace(TRAILING_SLASH_RE, "")}/use-cases`;

        return {
            links: [{ href: url, rel: "canonical" }],
            meta: seo({
                description: i18n._(
                    msg`See how Neore runs scheduled routines, asks before risky actions, and answers from Telegram, WhatsApp, Slack and Discord.`,
                ),
                image: `${env.VITE_SITE_URL.replace(TRAILING_SLASH_RE, "")}/og.png`,
                keywords: "Neore use cases, scheduled AI tasks, AI agent approvals, AI in messaging apps",
                title: i18n._(msg`Use cases — what Neore does`),
                url: "/use-cases",
            }),
            scripts: [
                jsonLd({
                    "@context": "https://schema.org",
                    "@type": "CollectionPage",
                    description: i18n._(msg`Use cases for Neore: routines, approvals and messaging apps`),
                    name: i18n._(msg`Neore use cases`),
                    url,
                }),
            ],
        };
    },
});
