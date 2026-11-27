import { Link, useNavigate } from "@tanstack/react-router";
import type { ComponentProps, FC } from "react";
import { useCallback } from "react";

import { settingsLinkSearch } from "@/features/settings/lib/settings-link";
import type { SettingsTab } from "@/features/settings/lib/settings-navigation";

// The registered router type is the widened `createTanstackRouter` return (see `src/router.tsx`), which collapses the
// search-updater type to `never`; the updater itself only adds the modal's own keys to the current search.
type SearchUpdater = NonNullable<ComponentProps<typeof Link>["search"]>;

/**
 * A link that opens settings at `tab` over the current page. It stays on the page, so the modal closes back to it, and
 * it is still a real link: it can open in a new tab.
 */
const SettingsLink: FC<Omit<ComponentProps<typeof Link>, "search" | "to"> & { anchor?: string; tab: SettingsTab }> = ({ anchor, tab, ...properties }) => (
    <Link {...properties} search={settingsLinkSearch(tab, anchor) as unknown as SearchUpdater} to="." />
);

/** Opens settings at a tab over the current page, for a control that is not a link. */
export const useOpenSettings = (): ((tab: SettingsTab, options?: { anchor?: string; replace?: boolean }) => void) => {
    const navigate = useNavigate();

    return useCallback(
        (tab: SettingsTab, options?: { anchor?: string; replace?: boolean }) => {
            void navigate({ replace: options?.replace, search: settingsLinkSearch(tab, options?.anchor) as unknown as SearchUpdater, to: "." });
        },
        [navigate],
    );
};

export default SettingsLink;
