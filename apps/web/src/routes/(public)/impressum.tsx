import { createFileRoute } from "@tanstack/react-router";

import ImpressumPage from "@/features/marketing/pages/impressum-page";
import env from "@/lib/env";
import { seo } from "@/lib/seo";

const TRAILING_SLASH_RE = /\/$/;

export const Route = createFileRoute("/(public)/impressum")({
    component: ImpressumPage,
    head: () => {
        return {
            links: [{ href: `${env.VITE_SITE_URL.replace(TRAILING_SLASH_RE, "")}/impressum`, rel: "canonical" }],
            meta: seo({
                description: "Impressum und Angaben gemäß § 5 DDG für Neore Chat.",
                title: "Impressum",
                url: "/impressum",
            }),
        };
    },
});
