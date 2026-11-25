/**
 * `getAgent` hands every agent the built-ins' formatters, so a saved result of a tool the run does not offer still
 * reaches the model as the tool's view (`withApprovedToolModelOutputs`).
 */
import { MODEL_REGISTRY } from "@neore/ai/models";
import { describe, expect, it } from "vitest";

import { NO_SERVICE_FETCH } from "../../lib/services";
import browserTool from "../tools/browser";
import getAgent from "./get-agent";

const model = MODEL_REGISTRY.find((m) => m.enabled !== false && m.provider !== "external" && (m.mode ?? "text") === "text");

describe("getAgent built-in tool formatter", () => {
    it("finds a built-in by name, whatever tools the run offers, and nothing for any other name", async () => {
        const agent = await getAgent(model!.id, { gateway: NO_SERVICE_FETCH, tools: {} });
        const formatter = agent.options.builtInToolFormatter!;

        const browser = await formatter("browser");

        expect(browser?.toModelOutput).toBe(browserTool.toModelOutput);
        await expect(formatter("mcp_server__tool")).resolves.toBeUndefined();
    });
});
