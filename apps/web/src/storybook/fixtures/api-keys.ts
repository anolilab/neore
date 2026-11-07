import { delay, http, HttpResponse } from "msw";
import type { HttpHandler } from "msw";

import type { ApiKey } from "@/features/auth/types/data-structure-types";

import { DAY, HOUR, STORY_NOW as NOW } from "../clock";

const key = (fixture: Partial<ApiKey> & Pick<ApiKey, "id" | "name" | "start">): ApiKey => {
    return { createdAt: new Date(NOW - 30 * DAY), updatedAt: new Date(NOW - 30 * DAY), ...fixture };
};

export const API_KEYS: ApiKey[] = [
    key({
        expiresAt: new Date(NOW + 60 * DAY),
        id: "key_cli",
        lastRequest: new Date(NOW - 2 * HOUR),
        name: "Laptop CLI",
        permissions: { chat: ["write"], threads: ["read"] },
        start: "app_7Fq2",
    }),
    key({ createdAt: new Date(NOW - 5 * DAY), id: "key_ci", name: "CI nightly export", permissions: { threads: ["read"] }, start: "app_Kd91" }),
    key({ id: "key_legacy", lastRequest: null, name: "Old integration", permissions: null, start: "app_00aZ" }),
];

/**
 * better-auth's `GET /api/auth/api-key/list` (a page, not a bare array). `"pending"` never
 * answers; `"error"` fails as better-auth does.
 */
export const apiKeyHandlers = (keys: ApiKey[] | "error" | "pending" = API_KEYS): HttpHandler[] => [
    http.get("*/api/auth/api-key/list", async () => {
        if (keys === "pending") {
            await delay("infinite");
        }

        if (keys === "error") {
            return HttpResponse.json({ code: "INTERNAL_SERVER_ERROR", message: "Could not list keys" }, { status: 500 });
        }

        const page = keys === "pending" ? [] : keys;

        return HttpResponse.json({ apiKeys: page, limit: 100, offset: 0, total: page.length });
    }),
];
