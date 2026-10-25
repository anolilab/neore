import { afterEach, describe, expect, it, vi } from "vitest";

import { erasePostHogPerson } from "./posthog-steps";

const CONFIGURED = { POSTHOG_HOST: "https://eu.i.posthog.com", POSTHOG_PERSONAL_API_KEY: "phx_key", POSTHOG_PROJECT_ID: "42" };

const stubFetch = (response: Response) => {
    const fetchMock = vi.fn(async () => response);

    vi.stubGlobal("fetch", fetchMock);

    return fetchMock;
};

afterEach(() => {
    vi.unstubAllGlobals();
});

describe(erasePostHogPerson, () => {
    it("posts the bulk delete to the app host and reports deleted on 2xx", async () => {
        const fetchMock = stubFetch(new Response(null, { status: 202 }));

        await expect(erasePostHogPerson("user-1", CONFIGURED)).resolves.toBe("deleted");

        const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];

        expect(url).toBe("https://eu.posthog.com/api/projects/42/persons/bulk_delete/");
        expect(JSON.parse(init.body as string)).toStrictEqual({ delete_events: true, distinct_ids: ["user-1"] });
    });

    it("treats 404 as success: there is no person to delete", async () => {
        stubFetch(new Response("not found", { status: 404, statusText: "Not Found" }));

        await expect(erasePostHogPerson("user-1", CONFIGURED)).resolves.toBe("not_found");
    });

    it.each([400, 401, 403, 429, 500, 503])("throws on a %i so the workflow step retries", async (status) => {
        stubFetch(new Response("nope", { status }));

        await expect(erasePostHogPerson("user-1", CONFIGURED)).rejects.toThrow(`Failed to delete person user-1: ${String(status)}`);
    });

    it("lets a network failure propagate", async () => {
        vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));

        await expect(erasePostHogPerson("user-1", CONFIGURED)).rejects.toThrow("fetch failed");
    });

    it.each([{ POSTHOG_PERSONAL_API_KEY: undefined, POSTHOG_PROJECT_ID: "42" }, { POSTHOG_PERSONAL_API_KEY: "phx_key", POSTHOG_PROJECT_ID: undefined }, {}])(
        "reports skipped, without calling PostHog, when unconfigured (%j)",
        async (env) => {
            const fetchMock = stubFetch(new Response(null, { status: 200 }));

            await expect(erasePostHogPerson("user-1", env)).resolves.toBe("skipped");
            expect(fetchMock).not.toHaveBeenCalled();
        },
    );
});
