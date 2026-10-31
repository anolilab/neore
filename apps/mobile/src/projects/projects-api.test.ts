import type { LunoraClient } from "@lunora/client";
import { api } from "@neore/backend/api";
import { describe, expect, it, vi } from "vitest";

import { DEFAULT_CHAT_MODEL } from "../lib/defaults";
import { MAX_PROJECT_TITLE_LENGTH } from "./project-title";
import type { ProjectRow } from "./projects-api";
import { createProject, isWriteBlocked, ProjectInputError, startProjectThread, watchProject, watchProjects, watchProjectThreads } from "./projects-api";

type Callback = (data: unknown) => void;

/** A client whose live queries the test drives by hand: `push` plays a server frame to every subscriber. */
const fakeClient = () => {
    const callbacks: Callback[] = [];
    const subscribe = vi.fn((_function: unknown, _args: unknown, callback: Callback, _options?: unknown) => {
        callbacks.push(callback);

        return () => {
            callbacks.splice(callbacks.indexOf(callback), 1);
        };
    });
    const mutation = vi.fn(async (..._arguments: unknown[]) => "created-id");
    const client = { mutation, subscribe } as unknown as LunoraClient;

    return {
        client,
        mutation,
        push: (data: unknown) => {
            for (const callback of callbacks) {
                callback(data);
            }
        },
        subscribe,
        subscribers: () => callbacks.length,
    };
};

const projectDocument = (id: string, title: string, extra: { defaultModel?: string; description?: string } = {}) => {
    return { _creationTime: 1, _id: id, createdAt: 1, title, ...extra };
};

const page = (...projects: unknown[]) => {
    return { continueCursor: null, isDone: true, page: projects };
};

describe("watchProjects", () => {
    it("subscribes to listProjects and hands the list over as rows", () => {
        const fake = fakeClient();
        const rows: ProjectRow[][] = [];

        watchProjects(
            fake.client,
            (next) => {
                rows.push(next);
            },
            vi.fn(),
        );

        expect(fake.subscribe.mock.calls[0]?.[0]).toBe(api.projects.functions.listProjects);
        expect(fake.subscribe.mock.calls[0]?.[1]).toEqual({ paginationOpts: { cursor: null, numItems: 100 } });

        fake.push(page(projectDocument("p1", "Roadmap", { defaultModel: "m", description: "Q4" })));

        expect(rows).toEqual([[{ defaultModel: "m", description: "Q4", id: "p1", title: "Roadmap" }]]);
    });

    it("updates when a project arrives, for example one made on the web", () => {
        const fake = fakeClient();
        let latest: ProjectRow[] = [];

        watchProjects(
            fake.client,
            (next) => {
                latest = next;
            },
            vi.fn(),
        );

        fake.push(page(projectDocument("p1", "Roadmap")));
        expect(latest.map((row) => row.title)).toEqual(["Roadmap"]);

        fake.push(page(projectDocument("p2", "From the web"), projectDocument("p1", "Roadmap")));
        expect(latest.map((row) => row.title)).toEqual(["From the web", "Roadmap"]);
    });

    it("reports a failed subscription and stops on unsubscribe", () => {
        const fake = fakeClient();
        const onError = vi.fn();

        const stop = watchProjects(fake.client, vi.fn(), onError);

        const options = fake.subscribe.mock.calls[0]?.[3] as { onError: (error: { message: string }) => void };

        options.onError({ message: "boom" });
        expect(onError).toHaveBeenCalledWith("boom");

        stop();
        expect(fake.subscribers()).toBe(0);
    });
});

describe("watchProjectThreads", () => {
    it("subscribes to the project's threads and untitled ones get a placeholder title", () => {
        const fake = fakeClient();
        const rows: { id: string; title: string }[][] = [];

        watchProjectThreads(
            fake.client,
            "p1",
            (next) => {
                rows.push(next);
            },
            vi.fn(),
        );

        expect(fake.subscribe.mock.calls[0]?.[0]).toBe(api.projects.functions.listThreadsByProject);
        expect(fake.subscribe.mock.calls[0]?.[1]).toEqual({ paginationOpts: { cursor: null, numItems: 100 }, projectId: "p1" });

        fake.push(page({ _id: "t1", title: "Plan" }, { _id: "t2", title: "" }));

        expect(rows).toEqual([
            [
                { id: "t1", title: "Plan" },
                { id: "t2", title: "Untitled" },
            ],
        ]);
    });
});

describe("createProject", () => {
    it("calls createProject with the trimmed name, online only, and returns the new id", async () => {
        const fake = fakeClient();

        await expect(createProject(fake.client, "  Roadmap ")).resolves.toEqual({ id: "created-id", title: "Roadmap" });

        expect(fake.mutation).toHaveBeenCalledTimes(1);
        expect(fake.mutation).toHaveBeenCalledWith(api.projects.functions.createProject, { title: "Roadmap" }, { onlineOnly: true });
    });

    it("shows the created project once the live list delivers it", async () => {
        const fake = fakeClient();
        let latest: ProjectRow[] = [];

        watchProjects(
            fake.client,
            (next) => {
                latest = next;
            },
            vi.fn(),
        );
        fake.push(page());

        const created = await createProject(fake.client, "Roadmap");

        fake.push(page(projectDocument(created.id, created.title)));

        expect(latest).toEqual([{ id: "created-id", title: "Roadmap" }]);
    });

    it.each(["", " ".repeat(3), "a".repeat(MAX_PROJECT_TITLE_LENGTH + 1)])("refuses %j before any call is made", async (name) => {
        const fake = fakeClient();

        await expect(createProject(fake.client, name)).rejects.toBeInstanceOf(ProjectInputError);
        expect(fake.mutation).not.toHaveBeenCalled();
    });
});

describe("startProjectThread", () => {
    it("creates a thread in the project on the project's own model, online only", async () => {
        const fake = fakeClient();

        await expect(startProjectThread(fake.client, { defaultModel: "proj-model", id: "p1" })).resolves.toBe("created-id");

        expect(fake.mutation).toHaveBeenCalledWith(api.chat.functions.createThread, { model: "proj-model", projectId: "p1" }, { onlineOnly: true });
    });

    it("falls back to the app's default model", async () => {
        const fake = fakeClient();

        await startProjectThread(fake.client, { id: "p1" });

        expect(fake.mutation.mock.calls[0]?.[1]).toEqual({ model: DEFAULT_CHAT_MODEL, projectId: "p1" });
    });
});

/** Walks a value looking for anything that holds file bytes. */
const isHoldingBytes = (value: unknown): boolean => {
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value) || (typeof Blob !== "undefined" && value instanceof Blob)) {
        return true;
    }

    if (typeof value === "object" && value !== null) {
        return Object.values(value).some((item) => isHoldingBytes(item));
    }

    return false;
};

describe("mutation arguments", () => {
    it("carry names and ids only, never file bytes", async () => {
        const fake = fakeClient();

        await createProject(fake.client, "Roadmap");
        await startProjectThread(fake.client, { id: "p1" });

        for (const call of fake.mutation.mock.calls) {
            const args = call[1] as { [key: string]: unknown };

            expect(Object.values(args).every((value) => typeof value === "string")).toBe(true);
            expect(isHoldingBytes(args)).toBe(false);
        }
    });

    it("the byte walker does catch bytes", () => {
        expect(isHoldingBytes({ nested: { file: new Uint8Array(2) } })).toBe(true);
        expect(isHoldingBytes({ file: new ArrayBuffer(2) })).toBe(true);
    });
});

describe("watchProject", () => {
    it("subscribes to getProject and hands over the one row, with its model", () => {
        const fake = fakeClient();
        const rows: ProjectRow[][] = [];

        watchProject(
            fake.client,
            "p1",
            (next) => {
                rows.push(next);
            },
            vi.fn(),
        );

        expect(fake.subscribe.mock.calls[0]?.[0]).toBe(api.projects.functions.getProject);
        expect(fake.subscribe.mock.calls[0]?.[1]).toEqual({ projectId: "p1" });

        fake.push(projectDocument("p1", "Roadmap", { defaultModel: "proj-model" }));

        expect(rows).toEqual([[{ defaultModel: "proj-model", description: undefined, id: "p1", title: "Roadmap" }]]);
    });

    it("answers an empty list for a project that is gone or not shared", () => {
        const fake = fakeClient();
        const rows: ProjectRow[][] = [];

        watchProject(
            fake.client,
            "p1",
            (next) => {
                rows.push(next);
            },
            vi.fn(),
        );
        fake.push(null);

        expect(rows).toEqual([[]]);
    });
});

describe("isWriteBlocked", () => {
    it.each([
        [{ busy: false, offline: false }, false],
        [{ busy: true, offline: false }, true],
        [{ busy: false, offline: true }, true],
        [{ busy: true, offline: true }, true],
    ])("%j -> %s", (state, expected) => {
        expect(isWriteBlocked(state)).toBe(expected);
    });
});
