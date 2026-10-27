/**
 * `getAgent` puts a `FallbackLanguageModel` over the chosen model only when the
 * user's backup model is a different model the registry can serve.
 */
import { MODEL_REGISTRY } from "@neore/ai/models";
import { describe, expect, it } from "vitest";

import { NO_SERVICE_FETCH } from "../../lib/services";
import { FallbackLanguageModel } from "./fallback-language-model";
import { GatewayLanguageModel } from "./gateway-language-model";
import getAgent from "./get-agent";

const [primary, other] = MODEL_REGISTRY.filter((m) => m.enabled !== false && m.provider !== "external" && (m.mode ?? "text") === "text");

const languageModelOf = async (backupModelId: string | undefined) => {
    const agent = await getAgent(primary!.id, { backupModelId, gateway: NO_SERVICE_FETCH });

    return agent.options.languageModel;
};

describe("getAgent backup model", () => {
    it("is unchanged without a backup", async () => {
        expect(await languageModelOf(undefined)).toBeInstanceOf(GatewayLanguageModel);
    });

    it("wraps the chosen model when a different backup is set", async () => {
        const model = await languageModelOf(other!.id);

        expect(model).toBeInstanceOf(FallbackLanguageModel);
        expect(model).toMatchObject({ modelId: primary!.id });
    });

    it("does not fall back to the chosen model itself", async () => {
        expect(await languageModelOf(primary!.id)).toBeInstanceOf(GatewayLanguageModel);
    });

    it("ignores a backup the registry does not know", async () => {
        expect(await languageModelOf("no-such-model")).toBeInstanceOf(GatewayLanguageModel);
    });
});
