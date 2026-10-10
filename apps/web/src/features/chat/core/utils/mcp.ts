const WORD_SEPARATOR_RE = /[\s\-_./]+/;

/**
 * Extract up to 2 uppercase initials from an MCP server name.
 *
 * Multi-word names use the first letter of the first two words:
 *   "Brave Search" → "BS"
 *
 * Single-word names use the first two characters:
 *   "Scira" → "SC".
 */
export const getServerInitials = (name: string): string => {
    const words = name.trim().split(WORD_SEPARATOR_RE).filter(Boolean);

    if (words.length >= 2) {
        return (words[0]![0]! + words[1]![0]!).toUpperCase();
    }

    return name.slice(0, 2).toUpperCase();
};

/**
 * Derive a favicon URL for an MCP server from its endpoint URL.
 * Uses DuckDuckGo's icon service. Returns undefined if the URL is invalid.
 * @example getServerFaviconUrl("https://mcp.example.com/sse") → "https://icons.duckduckgo.com/ip3/mcp.example.com.ico"
 */
export const getServerFaviconUrl = (serverUrl: string): string | undefined => {
    try {
        const { hostname } = new URL(serverUrl);

        if (!hostname || hostname === "localhost" || hostname === "127.0.0.1") {
            return undefined;
        }

        return `https://icons.duckduckgo.com/ip3/${hostname}.ico`;
    } catch {
        return undefined;
    }
};
