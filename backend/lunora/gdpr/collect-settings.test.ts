/**
 * What the data export carries of the AI preferences row: the settings, never a stored secret.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import schema from "../schema";
import { collectSettings } from "./steps";

type Harness = ReturnType<typeof lunoraTest>;

const USER = "user-a";

let harness: Harness;

beforeEach(() => {
    harness = lunoraTest(schema as never);
});

afterEach(() => {
    harness.close();
});

describe("collectSettings", () => {
    it("leaves every stored secret out of the export, the MCP header secrets included", async () => {
        await harness.run(async (ctx: any) => {
            await ctx.db.insert("aiUserPreferences", {
                mcpSecretHeaders: [{ encryptedValue: "ciphertext", header: "Authorization", server: "docs", url: "https://mcp.example.com" }],
                userId: USER,
            });
        });

        const exported = (await harness.run(async (ctx: any) => await ctx.runQuery(collectSettings, { userId: USER }))) as {
            aiUserPreferences: Record<string, unknown> | null;
        };

        expect(exported.aiUserPreferences).not.toBeNull();
        expect(exported.aiUserPreferences?.mcpSecretHeaders).toBeUndefined();
        expect(JSON.stringify(exported)).not.toContain("ciphertext");
    });
});
