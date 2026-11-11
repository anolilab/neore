/** `createProject` with the machine and folder a project lives in. */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi, registerModule } from "../../test/registered-api";

import { MAX_PROJECT_PATH_BYTES } from "./machine-location";
import { createProject } from "./functions";
import schema from "../schema";

const registry = vi.hoisted(() => new Map<string, unknown>());

vi.mock("../_generated/api", async (importOriginal) => registeredApi(await importOriginal(), registry));
vi.mock("../_generated/internal", async (importOriginal) => registeredApi(await importOriginal(), registry));

beforeAll(async () => {
    registerModule(registry, "agent_projects", await import("../agent/projects"));
});

vi.mock("../lib/crpc-auth-helpers", async (importOriginal) => {
    const sessionFrom = async (context: { auth: { userId?: string | null } }) =>
        context.auth.userId ? { activeOrganization: null, id: context.auth.userId, isAdmin: false, userId: context.auth.userId } : null;

    return {
        ...(await importOriginal<typeof import("../lib/crpc-auth-helpers")>()),
        getSessionUser: sessionFrom,
        getSessionUserForQuery: sessionFrom,
        getSessionUserForQueryLite: sessionFrom,
    };
});

const OWNER = "owner";
const STRANGER = "stranger";
const NOT_FOUND = /machine not found/iu;
const BAD_PATH = /absolute path/iu;

let harness: ReturnType<typeof lunoraTest>;

const as = (userId: string) => harness.withIdentity({ userId } as never);

const insertDevice = async (userId: string, fields: Record<string, unknown> = {}) =>
    (await harness.run(async (ctx: any) => await ctx.db.insert("devices", { createdAt: 0, name: "Laptop", platform: "linux", userId, ...fields }))) as string;

const create = async (args: Record<string, unknown>) => (await as(OWNER).mutation(createProject as never, { title: "Project", ...args } as never)) as string;

const stored = async (id: string) => await harness.run(async (ctx: any) => await ctx.db.projects.findFirst({ where: { _id: id } }));

beforeEach(() => {
    harness = lunoraTest(schema as never);
});

afterEach(() => {
    harness.close();
});

describe("createProject machine and folder", () => {
    it("stores the machine and folder of an owned, live device", async () => {
        const machineId = await insertDevice(OWNER);
        const id = await create({ machineId, path: "/Users/me/code/app" });

        expect(await stored(id)).toMatchObject({ machineId, path: "/Users/me/code/app" });
    });

    it("accepts a Windows drive path", async () => {
        const machineId = await insertDevice(OWNER);
        const id = await create({ machineId, path: String.raw`C:\Users\me\app` });

        const row = await stored(id);

        expect(row?.path).toBe(String.raw`C:\Users\me\app`);
    });

    it("refuses another user's device", async () => {
        const machineId = await insertDevice(STRANGER);

        await expect(create({ machineId, path: "/tmp/app" })).rejects.toThrow(NOT_FOUND);
    });

    it("refuses a revoked device", async () => {
        const machineId = await insertDevice(OWNER, { revokedAt: 1 });

        await expect(create({ machineId, path: "/tmp/app" })).rejects.toThrow(NOT_FOUND);
    });

    it("refuses a relative path", async () => {
        const machineId = await insertDevice(OWNER);

        await expect(create({ machineId, path: "code/app" })).rejects.toThrow(BAD_PATH);
    });

    it("refuses a path with a NUL", async () => {
        const machineId = await insertDevice(OWNER);

        await expect(create({ machineId, path: "/tmp/a\u{0}b" })).rejects.toThrow(BAD_PATH);
    });

    it("refuses a path over 1024 bytes, counting bytes and not characters", async () => {
        const machineId = await insertDevice(OWNER);

        await expect(create({ machineId, path: `/${"a".repeat(MAX_PROJECT_PATH_BYTES)}` })).rejects.toThrow();
        // 600 characters of 2 bytes each fit the argument cap but not the byte cap.
        await expect(create({ machineId, path: `/${"é".repeat(600)}` })).rejects.toThrow(BAD_PATH);
        expect(await stored(await create({ machineId, path: `/${"a".repeat(MAX_PROJECT_PATH_BYTES - 1)}` }))).toBeTruthy();
    });

    it("requires a path with a machine, and a machine with a path", async () => {
        const machineId = await insertDevice(OWNER);

        await expect(create({ machineId })).rejects.toThrow(BAD_PATH);
        await expect(create({ path: "/tmp/app" })).rejects.toThrow();
    });

    it("still creates a project without a machine", async () => {
        const id = await create({});
        const row = await stored(id);

        expect(row?.title).toBe("Project");
        expect(row?.machineId).toBeUndefined();
        expect(row?.path).toBeUndefined();
    });
});
