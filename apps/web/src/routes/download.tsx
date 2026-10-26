import { msg } from "@lingui/core/macro";
import { createFileRoute } from "@tanstack/react-router";

import DownloadPage from "@/features/download/components/download-page";
import env from "@/lib/env";
import { seo } from "@/lib/seo";

const TRAILING_SLASH_RE = /\/$/;

export const Route = createFileRoute("/download")({
    component: DownloadPage,
    head: ({ match }) => {
        const { i18n } = match.context;
        const url = `${env.VITE_SITE_URL.replace(TRAILING_SLASH_RE, "")}/download`;

        return {
            links: [{ href: url, rel: "canonical" }],
            meta: seo({
                description: i18n._(msg`Download the Neore desktop app for macOS, Windows and Linux.`),
                title: i18n._(msg`Download — Neore Desktop`),
                url: "/download",
            }),
        };
    },
});
