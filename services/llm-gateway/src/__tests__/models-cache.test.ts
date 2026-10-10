/**
 * `/v1/models` is sent `public` (shared caches may keep it), which is only
 * safe while its body cannot depend on who asks. These drive the real app, so
 * any middleware that starts personalising the catalog — auth tier, org,
 * BYOK, locale — breaks them.
 */
import { describe, expect, it } from "vitest";

import { app } from "../index.js";
import { createMockCtx as createMockContext, createMockEnv, makeVirtualKeyRow } from "./helpers/mock-env.js";

const APP_ORIGIN = "https://app.example";

const fetchModels = async (headers: Record<string, string>) => {
    const env = {
        ...createMockEnv({ apiKeyCacheRows: [await makeVirtualKeyRow("vk_enterprise", { org_id: "org-1", tier: "enterprise", uses_own_keys: 1 })] }),
        ALLOWED_ORIGINS: APP_ORIGIN,
        // Prices every model as the mock, so the catalog is built offline (no models.dev fetch).
        MOCK_LLM: "1",
    };
    const context = createMockContext();
    const response = await app.fetch(new Request("https://gateway.example/v1/models", { headers }), env, context as unknown as ExecutionContext);

    await context.flush();

    return response;
};

describe("/v1/models shared caching", () => {
    it("answers every caller with the same body", async () => {
        const anonymous = await fetchModels({});
        const callers: Record<string, string>[] = [
            { Authorization: "Bearer vk_enterprise" },
            { "Accept-Language": "de-DE", Cookie: "neore.session_token=abc" },
            { Origin: APP_ORIGIN, "X-Provider-Key": "sk-byok" },
        ];
        const bodies = await Promise.all(
            callers.map(async (headers) => {
                const response = await fetchModels(headers);

                return response.text();
            }),
        );

        const reference = await anonymous.text();

        expect(anonymous.status).toBe(200);

        for (const body of bodies) {
            expect(body).toBe(reference);
        }
    });

    it("is publicly cacheable and always varies on Origin, whose CORS headers do differ", async () => {
        const withOrigin = await fetchModels({ Origin: APP_ORIGIN });
        const withoutOrigin = await fetchModels({});

        expect(withOrigin.headers.get("Cache-Control")).toBe("public, max-age=300, stale-while-revalidate=3600");
        expect(withOrigin.headers.get("Access-Control-Allow-Origin")).toBe(APP_ORIGIN);
        expect(withOrigin.headers.get("Vary")).toBe("Origin");
        // The copy a no-Origin request would put in a shared cache must not be
        // served to the app, which needs Access-Control-Allow-Origin.
        expect(withoutOrigin.headers.get("Access-Control-Allow-Origin")).toBeNull();
        expect(withoutOrigin.headers.get("Vary")).toBe("Origin");
    });
});
