import { useLingui } from "@lingui/react/macro";
import { ToggleGroup, ToggleGroupItem } from "@neore/ui/components/toggle-group";
import type { FC } from "react";

import updateLocale, { isSupportedLocale } from "@/functions/update-locale";
import { DEFAULT_LOCALE, deLocalizeUrl, locales as appLocales } from "@/lib/intl/client";

const LanguageToggle: FC = () => {
    const { i18n, t } = useLingui();

    return (
        <ToggleGroup
            className="gap-1 rounded-md border-none bg-transparent p-0"
            onValueChange={(value) => {
                const locale = value?.[0];

                // `locales` is a `Record<string, string>`, so its keys arrive here as plain
                // strings. Narrow to the supported-locale union before handing it to the
                // server fn, which only accepts that union.
                if (!locale || !isSupportedLocale(locale)) {
                    return;
                }

                const currentUrl = new URL(globalThis.location.href);
                const delocalized = deLocalizeUrl({ url: currentUrl });
                const basePath = delocalized ? delocalized.pathname : currentUrl.pathname;

                const localizedBasePath = basePath === "/" ? "" : basePath;
                const newPath = locale === DEFAULT_LOCALE ? basePath + currentUrl.search : `/${locale}${localizedBasePath}${currentUrl.search}`;

                // Update the cookie server-side (fire-and-forget)
                void updateLocale({ data: locale });

                // Navigate to the new locale URL
                globalThis.location.assign(newPath);
            }}
            value={[i18n.locale ?? DEFAULT_LOCALE]}
            variant="outline"
        >
            {Object.entries(appLocales).map(([locale, label]) => (
                <ToggleGroupItem
                    aria-label={t`Switch to ${label}`}
                    className="h-auto rounded-sm border-none p-1 text-sm text-white hover:bg-white/10 hover:text-white focus-visible:ring-0 focus-visible:ring-offset-0"
                    key={locale}
                    value={locale}
                >
                    {label}
                </ToggleGroupItem>
            ))}
        </ToggleGroup>
    );
};

export default LanguageToggle;
