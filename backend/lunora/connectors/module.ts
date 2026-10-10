import { defineModule } from "lunorash/server";

export default defineModule({
    description: "MCP connectors: provider definitions, per-user OAuth grants (PKCE, DCR) and custom MCP servers.",
    tables: ["connectorDefinitions", "mcpServerGrants", "oauthStates", "userConnectors"],
});
