import { afterEach, describe, expect, it, vi } from "vitest";

import { erasePostHogPerson } from "./posthog-steps";

const CONFIGURED = { POSTHOG_HOST: "https://eu.i.posthog.com", POSTHOG_PERSONAL_API_KEY: "phx_key", POSTHOG_PROJECT_ID: "42" };

const stubFetch = (response: Response) => {
    const fetchMock = vi.fn(async () => response);

    vi.stubGlobal("fetch", fetchMock);

    return fetchMock;
};

/** Answers the person bulk-delete and the project lookup separately. */
const stubFetchByUrl = ({ person, project }: { person: Response; project: Response }) => {
    const fetchMock = vi.fn(async (url: string) => (url.endsWith("/bulk_delete/") ? person : project));

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

    it("reports no_profile, not deleted, on a 404 when the project check passes", async () => {
        const fetchMock = stubFetchByUrl({ person: new Response("not found", { status: 404 }), project: new Response("{}", { status: 200 }) });

        await expect(erasePostHogPerson("user-1", CONFIGURED)).resolves.toBe("no_profile");

        const [url, init] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];

        expect(url).toBe("https://eu.posthog.com/api/projects/42/");
        expect(init.headers).toStrictEqual({ Authorization: "Bearer phx_key" });
        expect(init.signal).toBeInstanceOf(AbortSignal);
    });

    it.each([401, 403, 404, 500])("throws on a 404 when the project check answers %i, so a wrong project id is never a success", async (status) => {
        stubFetchByUrl({ person: new Response("not found", { status: 404 }), project: new Response("nope", { status }) });

        await expect(erasePostHogPerson("user-1", CONFIGURED)).rejects.toThrow(`Project 42 could not be verified`);
    });

    it("does not check the project when the person delete succeeds", async () => {
        const fetchMock = stubFetchByUrl({ person: new Response(null, { status: 202 }), project: new Response("{}", { status: 200 }) });

        await expect(erasePostHogPerson("user-1", CONFIGURED)).resolves.toBe("deleted");
        expect(fetchMock).toHaveBeenCalledTimes(1);
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
