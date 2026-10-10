import { useLingui } from "@lingui/react/macro";
import { HeadingLevelProvider } from "@neore/ui/components/heading";
import type { ReactNode } from "react";

import { settingsPageName } from "@/features/layout/lib/dashboard-page-names";

/**
 * The heading outline of a settings page: its one `h1` (the page name the
 * breadcrumb and the nav show), and level 2 for what the page renders — so
 * every `Card`'s title becomes an `h2`, a card nested in it an `h3`.
 *
 * The `h1` is `sr-only`: the visible title already lives in the breadcrumb
 * (`aria-current="page"`), and several pages open with a visible heading or
 * card title of their own, so a second visible one would repeat it on screen.
 *
 * Off the settings tree (the dashboard home) it adds nothing.
 */
const SettingsPageOutline = ({ children, pathname }: { children: ReactNode; pathname: string }) => {
    const { i18n } = useLingui();
    const name = settingsPageName(pathname);

    if (!name) {
        return children;
    }

    return (
        <HeadingLevelProvider level={2}>
            <h1 className="sr-only">{i18n._(name)}</h1>
            {children}
        </HeadingLevelProvider>
    );
};

export default SettingsPageOutline;
