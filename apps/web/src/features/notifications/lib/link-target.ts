import { anchorFromHash, settingsLinkSearch, settingsTabForPath } from "@/features/settings/lib/settings-link";

type SearchUpdater = (previous: Record<string, unknown>) => Record<string, unknown>;

/**
 * A notification's stored link is an in-app path, optionally with a query (`/develop?repository=…&number=7`).
 * The router's `to` takes a path only: a query left in it is read as part of the path and matches no route, so the
 * query is handed over as `search` instead.
 *
 * A link to a settings page opens the settings modal over the current page instead (`settings-link.ts`).
 */
const linkTarget = (link: string): { search?: Record<string, string> | SearchUpdater; to: string } => {
    const url = new URL(link, "https://app.invalid");
    const settingsTab = settingsTabForPath(url.pathname);

    if (settingsTab) {
        return { search: settingsLinkSearch(settingsTab, anchorFromHash(url.hash)), to: "." };
    }

    const search: Record<string, string> = {};
    const entries = [...url.searchParams.entries()];

    for (const [key, value] of entries) {
        search[key] ??= value;
    }

    return entries.length === 0 ? { to: url.pathname } : { search, to: url.pathname };
};

export default linkTarget;
