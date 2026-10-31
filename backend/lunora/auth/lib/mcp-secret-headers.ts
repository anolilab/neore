/**
 * Header secrets of the user's MCP servers (`aiUserPreferences.mcpSecretHeaders`):
 * what `setMcpServerSecret` (`chat/lib/secret-consumers.ts`) stores and what a run reads back.
 *
 * They are kept apart from `mcpServers[].headers` so the plaintext list the Settings
 * page shows, writes back and the audit history snapshots never holds one. A run
 * (`getMCPServersQuery`) joins them to their server here, as plain headers; each is
 * bound to the server's name AND url, so a server that moved to another address
 * does not receive it.
 */
import { decryptKey } from "../../lib/encryption";

export interface McpSecretHeader {
    encryptedValue: string;
    header: string;
    server: string;
    url: string;
}

export interface McpServerHeaders {
    headers?: { key: string; value: string }[];
    name: string;
    url: string;
}

/** Whether two header names are the same field (names are case-insensitive). */
export const sameHeaderName = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/**
 * The secrets that still belong to a saved server: one whose server was deleted or moved to another address is dropped
 * (re-adding the same name and URL must not bring it back), and so is one for a header the user now sets by hand
 * in Settings (the typed value is the deliberate, later choice).
 */
export const pruneMcpSecretHeaders = (secrets: McpSecretHeader[], servers: McpServerHeaders[]): McpSecretHeader[] =>
    secrets.filter((secret) => {
        const server = servers.find((candidate) => candidate.name === secret.server && candidate.url === secret.url);

        return server !== undefined && (server.headers ?? []).every((header) => !sameHeaderName(header.key, secret.header));
    });

/**
 * `servers` with each saved secret added as a plain header on the server it was approved for.
 * A secret replaces a header of the same name; one that cannot be decrypted is left out
 * (the request goes without it and fails at the server) and nothing about it is logged.
 */
export const mcpServersWithSecretHeaders = async <Server extends McpServerHeaders>(
    servers: Server[],
    secrets: McpSecretHeader[] | undefined,
): Promise<Server[]> => {
    if (!secrets || secrets.length === 0) {
        return servers;
    }

    return await Promise.all(
        servers.map(async (server) => {
            const own = secrets.filter((secret) => secret.server === server.name && secret.url === server.url);
            const added: { key: string; value: string }[] = [];

            for (const secret of own) {
                try {
                    added.push({ key: secret.header, value: await decryptKey(secret.encryptedValue, "mcp-headers") });
                } catch {
                    // Unreadable: skipped.
                }
            }

            if (added.length === 0) {
                return server;
            }

            const kept = (server.headers ?? []).filter((header) => added.every((secret) => !sameHeaderName(secret.key, header.key)));

            return { ...server, headers: [...kept, ...added] };
        }),
    );
};
