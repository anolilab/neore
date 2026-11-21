/**
 * The provider cache readings are reachable where the backend calls them: through the InternalApi entrypoint, for an
 * allowlisted admin only. The route is registered on the app, so a request reaches it rather than a 404.
 */
import { describe, expect, it } from "vitest";

import type { AppEnv } from "../env.js";
import { InternalApi } from "../index.js";
import { createMockCtx, createMockEnv } from "./helpers/mock-env.js";
import { d1FromSqlite, migratedDatabase } from "./helpers/sqlite-d1.js";

const readingsFor = async (adminUserId: string, query = "") => {
    const env = { ...createMockEnv(), GATEWAY_ADMIN_USER_IDS: "admin-1", USAGE_DB: d1FromSqlite(migratedDatabase()) } as unknown as AppEnv;
    const entrypoint = new InternalApi(createMockCtx() as unknown as ExecutionContext, env);

    return entrypoint.fetch(new Request(`https://llm-gateway.internal/internal/admin/provider-cache?adminUserId=${adminUserId}${query}`));
};

describe("GET /internal/admin/provider-cache", () => {
    it("answers an allowlisted admin with the readings for the asked window", async () => {
        const res = await readingsFor("admin-1", "&days=30");

        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({ days: 30, hours: [], models: [] });
    });

    it("defaults to 7 days", async () => {
        const res = await readingsFor("admin-1");

        expect(await res.json()).toMatchObject({ days: 7 });
    });

    it("refuses a caller outside the allowlist", async () => {
        const res = await readingsFor("someone-else");

        expect(res.status).toBe(403);
    });

    it("refuses a window it does not offer", async () => {
        const res = await readingsFor("admin-1", "&days=90");

        expect(res.status).toBe(400);
    });
});
