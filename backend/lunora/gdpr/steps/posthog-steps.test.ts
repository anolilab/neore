import { afterEach, describe, expect, it, vi } from "vitest";

import { gdprLogger } from "../../lib/logger";
import { MAX_LENGTH } from "../../lib/validators";
import { deletePostHogPerson, erasePostHogPerson } from "./posthog-steps";

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

    it("cancels the body of a 2xx answer instead of leaving it unread", async () => {
        const cancelled = vi.fn();
        const body = new ReadableStream({ cancel: cancelled, pull() {} });

        stubFetch(new Response(body, { status: 200 }));

        await expect(erasePostHogPerson("user-1", CONFIGURED)).resolves.toBe("deleted");
        expect(cancelled).toHaveBeenCalledTimes(1);
    });

    it("reports no_profile, not deleted, on a 404 when the project check passes", async () => {
        const fetchMock = stubFetchByUrl({ person: new Response("not found", { status: 404 }), project: new Response("{}", { status: 200 }) });

        await expect(erasePostHogPerson("user-1", CONFIGURED)).resolves.toBe("no_profile");

        const [url, init] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];

        expect(url).toBe("https://eu.posthog.com/api/projects/42/");
        expect(init.headers).toStrictEqual({ Authorization: "Bearer phx_key" });
        expect(init.signal).toBeInstanceOf(AbortSignal);
    });

    it.each([401, 403])("names the missing project:read scope and logs it when the project lookup answers %i", async (status) => {
        const logSpy = vi.spyOn(gdprLogger, "error").mockImplementation(() => {});

        stubFetchByUrl({ person: new Response("not found", { status: 404 }), project: new Response("forbidden", { status }) });

        await expect(erasePostHogPerson("user-1", CONFIGURED)).rejects.toThrow("lacks the project:read scope");
        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("project:read"));
        logSpy.mockRestore();
    });

    it.each([404, 500])("throws on a 404 when the project check answers %i, so a wrong project id is never a success", async (status) => {
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

        await expect(erasePostHogPerson("user-1", CONFIGURED)).rejects.toThrow(`Failed to delete person: ${String(status)}`);
    });

    it("logs the status, never the user id or PostHog's response body, before rethrowing a rejected delete", async () => {
        const errorSpy = vi.spyOn(gdprLogger, "error").mockImplementation(() => {});

        stubFetch(new Response("rate limited by project", { status: 429 }));

        const failure = await erasePostHogPerson("user-1", CONFIGURED)
            .then(() => new Error("resolved"))
            .catch((error: unknown) => error as Error);

        expect(failure.message).toContain("429");
        expect(failure.message).not.toContain("user-1");
        expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("http_429"));
        expect(JSON.stringify(errorSpy.mock.calls)).not.toContain("user-1");
        expect(JSON.stringify(errorSpy.mock.calls)).not.toContain("rate limited by project");

        errorSpy.mockRestore();
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

describe("deletePostHogPerson input", () => {
    // The validator is the procedure's own; `args` is the only place the bound lives.
    const userIdValidator = (deletePostHogPerson as unknown as { args: { userId: { parse: (value: unknown) => unknown } } }).args.userId;

    it("accepts an id up to the shared id bound", () => {
        expect(() => userIdValidator.parse("x".repeat(MAX_LENGTH.id))).not.toThrow();
    });

    it("refuses an id past it", () => {
        expect(() => userIdValidator.parse("x".repeat(MAX_LENGTH.id + 1))).toThrow();
    });
});
