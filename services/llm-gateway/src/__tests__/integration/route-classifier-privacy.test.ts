/**
 * The classifier model reads the caller's prompt, so it is bound by the caller's filter rules: a caller who
 * requires zero retention, or whose rules exclude the classifier model, never has the prompt sent to it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { bindingEnv, makeInternalRequest } from "../helpers/internal.js";
import { createMockEnv } from "../helpers/mock-env.js";
import { useTrackedAppFetch } from "../helpers/tracked-app-fetch.js";

const classify = vi.hoisted(() => vi.fn());

vi.mock("../../routing/classifier.js", async (importOriginal) => {
    return { ...(await importOriginal<typeof import("../../routing/classifier.js")>()), classifyTierWithModel: classify };
});

const ENV = bindingEnv({ ...createMockEnv({ nodeEnv: "test" }), ROUTING_CLASSIFIER_MODEL: "gemini-2.5-flash" });
const fetchApp = useTrackedAppFetch();

const route = async (modelFilterRules?: Record<string, unknown>) => {
    const request = makeInternalRequest(
        "POST",
        "/internal/route",
        JSON.stringify({ messages: [{ content: "why does this deadlock?", role: "user" }], modelFilterRules, userTier: "pro" }),
    );

    return await fetchApp(request, ENV);
};

describe("POST /internal/route and the classifier model", () => {
    beforeEach(() => {
        classify.mockReset().mockResolvedValue(null);
    });

    it("asks the classifier when the caller has no filter rules", async () => {
        const response = await route();

        expect(response.status).toBe(200);
        expect(classify).toHaveBeenCalledTimes(1);
    });

    it("never calls the classifier for a caller who requires zero retention", async () => {
        const response = await route({ requireZDR: true });

        expect(response.status).toBe(200);
        expect(classify).not.toHaveBeenCalled();
    });

    it("never calls the classifier for a caller who denies data collection", async () => {
        const response = await route({ denyDataCollection: true });

        expect(response.status).toBe(200);
        expect(classify).not.toHaveBeenCalled();
    });

    it("never calls the classifier when the caller's rules exclude its provider", async () => {
        const response = await route({ blockedProviders: ["google"] });

        expect(response.status).toBe(200);
        expect(classify).not.toHaveBeenCalled();
    });
});
