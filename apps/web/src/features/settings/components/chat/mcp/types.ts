import type { ReturnOf } from "@lunora/react";
import type { api } from "@neore/backend/api";

export type MCPProtocol = "http" | "sse";

export interface MCPHeader {
    key: string;
    value: string;
}

/**
 * One value the user supplies while installing a catalogue server: a `{variable}`
 * in the remote URL, or a placeholder in a header template such as
 * `Bearer {api_key}`. Values fill every template that names the same key.
 */
export interface MCPSetupField {
    choices?: string[];
    description?: string;
    isRequired: boolean;
    isSecret: boolean;
    key: string;
    label: string;
}

/** Present only while installing from the catalogue — never persisted. */
export interface MCPServerSetup {
    fields: MCPSetupField[];
    headerTemplates: { key: string; template: string }[];
    urlTemplate: string;
    values: Record<string, string>;
}

export interface MCPServerFormData {
    enabled: boolean;
    headers: MCPHeader[];
    icon: string;
    name: string;
    protocol: MCPProtocol;
    setup?: MCPServerSetup;
    url: string;
}

export interface MCPServerConfig {
    enabled: boolean;
    headers?: MCPHeader[];
    icon?: string;
    name: string;
    protocol: MCPProtocol;
    url: string;
}

/** Per-server connection status cached in local component state */
export type ServerStatus = "connected" | "connecting" | "error" | "idle";

export interface ServerStatusInfo {
    error?: string;
    latencyMs?: number;
    /** The last test found the server wants OAuth (401 / protected-resource metadata). */
    requiresOAuth?: boolean;
    status: ServerStatus;
    tools: string[];
}

/** One MCP Registry server, as `chat_mcp_registry.listMcpRegistryServers` returns it. */
type RegistryServer = Extract<ReturnOf<typeof api.chat.mcp_registry.listMcpRegistryServers>, { ok: true }>["servers"][number];

export type CatalogRemote = RegistryServer["remotes"][number];

/** A server offered for one-click install — from the MCP Registry or the fallback list. */
export type CatalogServer = Omit<RegistryServer, "version"> & {
    /** Fallback entries only: the server needs credentials the registry would have described. */
    authRequired?: boolean;
};

/** A stored OAuth sign-in for one of the user's servers, as `connectors_mcp_servers.listMcpServerSignIns` returns it. */
export type MCPServerSignIn = ReturnOf<typeof api.connectors.mcp_servers.listMcpServerSignIns>[number];
