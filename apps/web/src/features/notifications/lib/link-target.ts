/**
 * A notification's stored link is an in-app path, optionally with a query (`/develop?repository=…&number=7`).
 * The router's `to` takes a path only: a query left in it is read as part of the path and matches no route, so the
 * query is handed over as `search` instead.
 */
const linkTarget = (link: string): { search?: Record<string, string>; to: string } => {
    const url = new URL(link, "https://app.invalid");
    const search: Record<string, string> = {};
    const entries = [...url.searchParams.entries()];

    for (const [key, value] of entries) {
        search[key] ??= value;
    }

    return entries.length === 0 ? { to: url.pathname } : { search, to: url.pathname };
};

export default linkTarget;
