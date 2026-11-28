import { defineModule } from "lunorash/server";

export default defineModule({
    description:
        "The public /api/v1 REST surface and its OpenAPI spec, served over existing procedures as the API key's owner, the MCP endpoint's Events log (`mcpEvents`) and its sequence watermark, and its webhook subscriptions.",
    tables: ["eventWebhookSubscriptions", "mcpEvents", "mcpEventWatermarks"],
});
