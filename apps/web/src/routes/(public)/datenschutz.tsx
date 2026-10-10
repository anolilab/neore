import { createFileRoute } from "@tanstack/react-router";

import DatenschutzPage from "@/features/marketing/pages/datenschutz-page";
import env from "@/lib/env";
import { seo } from "@/lib/seo";

const TRAILING_SLASH_RE = /\/$/;

export const Route = createFileRoute("/(public)/datenschutz")({
    component: DatenschutzPage,
    head: () => {
        return {
            links: [{ href: `${env.VITE_SITE_URL.replace(TRAILING_SLASH_RE, "")}/datenschutz`, rel: "canonical" }],
            meta: seo({
                description: "Datenschutzerklärung für Neore Chat. Informationen zur Verarbeitung personenbezogener Daten gemäß DSGVO.",
                title: "Datenschutzerklärung",
                url: "/datenschutz",
            }),
        };
    },
});
