import type { defineConfig } from "@lingui/cli";

type LinguiConfig = Parameters<typeof defineConfig>[0];

const config: LinguiConfig = {
    catalogs: [
        {
            include: ["src", "../../packages/ui/src", "../../packages/chat-ui/src"],
            path: "<rootDir>/src/locales/{locale}/messages",
        },
    ],
    locales: ["de", "en", "es", "fr", "it", "ja", "pl", "pt", "zh"],
    sourceLocale: "en",
};

export default config;
