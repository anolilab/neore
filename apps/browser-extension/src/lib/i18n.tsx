import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import type { ReactNode } from "react";

// `@neore/chat-ui` renders its strings through Lingui macros, which throw at
// runtime unless an I18nProvider is mounted. The extension ships no compiled
// catalog: the babel plugin keeps each message's source text in the build
// (`descriptorFields: "message"` in vite.config.ts), and an empty English
// catalog falls back to exactly that.
// eslint-disable-next-line unicorn/no-top-level-side-effects -- activation must precede the first render of any importer; that is this module's job
i18n.loadAndActivate({ locale: "en", messages: {} });

export function ExtensionI18nProvider({ children }: { children: ReactNode }) {
    return <I18nProvider i18n={i18n}>{children}</I18nProvider>;
}
