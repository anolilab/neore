/**
 * The settings lock on the preference write surface. The policy table is a
 * one-method fake that counts reads; the lock decision itself is the real one,
 * and every policy document is built through the policy parser.
 */
import { describe, expect, it } from "vitest";

import { compareStrings } from "../../lib/collections";

import { MANAGED_SETTINGS, parseOrganizationPolicy, serializeOrganizationPolicy } from "./organization-policy";
import type { ManagedSettingKey, SettingPolicy } from "./organization-policy";
import { assertSettingsWritable, saveAiUserPreferences, saveUserSettings } from "./preference-writes";

type Database = Parameters<typeof assertSettingsWritable>[0];

const MANAGED_KEYS = Object.keys(MANAGED_SETTINGS) as ManagedSettingKey[];

/** A stored policy document for these per-key settings, built and validated by the parser. */
const policyDocument = (settings: Partial<Record<ManagedSettingKey, SettingPolicy>>): string => {
    const parsed = parseOrganizationPolicy(JSON.stringify({ schemaVersion: 1, settings }));

    if (!parsed.ok) {
        throw new Error(parsed.error);
    }

    return serializeOrganizationPolicy(parsed.policy);
};

const lockAll = (keys: ReadonlyArray<ManagedSettingKey>): string =>
    policyDocument(Object.fromEntries(keys.map((key) => [key, { locked: true, value: false }])));

/** What the fake policy table holds: no row, a document, or a read that fails. */
type PolicyRow = string | null | Error;

const fakeDatabase = (row: PolicyRow) => {
    const reads: string[] = [];
    const writes: string[] = [];
    const db = {
        insert: async (table: string) => {
            writes.push(`insert ${table}`);
        },
        organizationPolicies: {
            findFirst: async ({ where }: { where: { organizationId: string } }) => {
                reads.push(where.organizationId);

                if (row instanceof Error) {
                    throw row;
                }

                return row === null ? null : { document: row };
            },
        },
        patch: async (table: string) => {
            writes.push(`patch ${table}`);
        },
    };

    return { db: db as unknown as Database, reads, writes };
};

describe("assertSettingsWritable, every managed key", () => {
    it("covers the managed keys it is meant to", () => {
        expect(MANAGED_KEYS.length).toBeGreaterThan(0);
    });

    it.each(MANAGED_KEYS)("refuses %s when the policy locks it, whatever the value", async (key) => {
        const { db } = fakeDatabase(lockAll([key]));

        for (const value of [true, false]) {
            await expect(assertSettingsWritable(db, "org_1", { [key]: value })).rejects.toMatchObject({
                code: "FORBIDDEN",
                message: expect.stringContaining(key),
            });
        }
    });

    it.each(MANAGED_KEYS)("allows %s when the policy only defaults it", async (key) => {
        const { db, reads } = fakeDatabase(policyDocument({ [key]: { locked: false, value: true } }));

        await expect(assertSettingsWritable(db, "org_1", { [key]: false })).resolves.toBeUndefined();
        expect(reads).toEqual(["org_1"]);
    });

    it.each(MANAGED_KEYS)("allows %s when the policy locks only the other managed keys", async (key) => {
        const { db } = fakeDatabase(lockAll(MANAGED_KEYS.filter((other) => other !== key)));

        await expect(assertSettingsWritable(db, "org_1", { [key]: true })).resolves.toBeUndefined();
    });

    it.each(MANAGED_KEYS)("allows %s when the policy does not name it", async (key) => {
        const { db } = fakeDatabase(policyDocument({}));

        await expect(assertSettingsWritable(db, "org_1", { [key]: true })).resolves.toBeUndefined();
    });

    it("names every locked key of a patch and none of the others", async () => {
        const { db } = fakeDatabase(lockAll(MANAGED_KEYS));
        const patch = Object.fromEntries([...MANAGED_KEYS.map((key) => [key, true]), ["timezone", "UTC"]]);
        const sorted = [...MANAGED_KEYS].toSorted(compareStrings);

        await expect(assertSettingsWritable(db, "org_1", patch)).rejects.toMatchObject({
            message: expect.stringContaining(sorted.join(", ")),
        });
    });
});

describe("assertSettingsWritable, unmanaged keys", () => {
    it("lets a patch of unmanaged keys through without reading the policy, even with every managed key locked", async () => {
        const { db, reads } = fakeDatabase(lockAll(MANAGED_KEYS));

        await expect(assertSettingsWritable(db, "org_1", { timezone: "UTC", toolPermissions: {} })).resolves.toBeUndefined();
        expect(reads).toEqual([]);
    });

    it("reads nothing for a managed key left undefined", async () => {
        const { db, reads } = fakeDatabase(lockAll(MANAGED_KEYS));

        await expect(assertSettingsWritable(db, "org_1", { memoryEnabled: undefined, timezone: "UTC" })).resolves.toBeUndefined();
        expect(reads).toEqual([]);
    });

    it("reads the policy once when the patch carries a managed key", async () => {
        const { db, reads } = fakeDatabase(null);

        await assertSettingsWritable(db, "org_1", { memoryEnabled: true, timezone: "UTC" });

        expect(reads).toEqual(["org_1"]);
    });
});

describe("assertSettingsWritable, the caller's organization and the stored policy", () => {
    it.each(MANAGED_KEYS)("lets an internal writer with no organization change %s, reading nothing", async (key) => {
        const { db, reads } = fakeDatabase(lockAll(MANAGED_KEYS));

        await expect(assertSettingsWritable(db, null, { [key]: true })).resolves.toBeUndefined();
        expect(reads).toEqual([]);
    });

    it.each(MANAGED_KEYS)("lets %s through for an organization with no policy row", async (key) => {
        const { db, reads } = fakeDatabase(null);

        await expect(assertSettingsWritable(db, "org_1", { [key]: true })).resolves.toBeUndefined();
        expect(reads).toEqual(["org_1"]);
    });

    it.each(MANAGED_KEYS)("refuses %s when the stored policy cannot be read", async (key) => {
        for (const document of ["{ not json", '{"schemaVersion":1,"typo":true}', '{"schemaVersion":2}']) {
            const { db } = fakeDatabase(document);

            await expect(assertSettingsWritable(db, "org_1", { [key]: true })).rejects.toMatchObject({ code: "FORBIDDEN" });
        }
    });

    it("lets an unmanaged key through when the stored policy cannot be read, without reading it", async () => {
        const { db, reads } = fakeDatabase("{ not json");

        await expect(assertSettingsWritable(db, "org_1", { timezone: "UTC" })).resolves.toBeUndefined();
        expect(reads).toEqual([]);
    });

    it("does not let a managed key through when the policy read itself fails", async () => {
        const { db } = fakeDatabase(new Error("D1 unavailable"));

        await expect(assertSettingsWritable(db, "org_1", { memoryEnabled: true })).rejects.toThrow("D1 unavailable");
    });
});

describe("the savers check the lock before they write", () => {
    it("saveAiUserPreferences refuses a locked autoApproveLowRisk and writes nothing", async () => {
        const { db, writes } = fakeDatabase(lockAll(["autoApproveLowRisk"]));

        await expect(saveAiUserPreferences(db, { _id: "p1" as never }, "user_1", { autoApproveLowRisk: true }, "org_1")).rejects.toMatchObject({
            code: "FORBIDDEN",
        });
        await expect(saveAiUserPreferences(db, null, "user_1", { autoApproveLowRisk: true }, "org_1")).rejects.toMatchObject({ code: "FORBIDDEN" });
        expect(writes).toEqual([]);
    });

    it("saveAiUserPreferences writes an unlocked key, patching an existing row and inserting a missing one", async () => {
        const { db, writes } = fakeDatabase(lockAll(["memoryEnabled"]));

        await saveAiUserPreferences(db, { _id: "p1" as never }, "user_1", { autoApproveLowRisk: true }, "org_1");
        await saveAiUserPreferences(db, null, "user_1", { autoApproveLowRisk: true }, "org_1");

        expect(writes).toEqual(["patch aiUserPreferences", "insert aiUserPreferences"]);
    });

    it("saveUserSettings refuses a locked dailyBriefEnabled and writes nothing", async () => {
        const { db, writes } = fakeDatabase(lockAll(["dailyBriefEnabled"]));

        await expect(saveUserSettings(db, { _id: "s1" as never }, "user_1", { dailyBriefEnabled: true }, "org_1")).rejects.toMatchObject({
            code: "FORBIDDEN",
        });
        await expect(saveUserSettings(db, null, "user_1", { dailyBriefEnabled: false }, "org_1")).rejects.toMatchObject({ code: "FORBIDDEN" });
        expect(writes).toEqual([]);
    });

    it("saveUserSettings writes taskEmailEnabled under a policy that locks every managed key, reading nothing", async () => {
        const { db, reads, writes } = fakeDatabase(lockAll(MANAGED_KEYS));

        await saveUserSettings(db, { _id: "s1" as never }, "user_1", { taskEmailEnabled: true }, "org_1");

        expect(reads).toEqual([]);
        expect(writes).toEqual(["patch userSettings"]);
    });

    it("both savers skip the lock for a writer with no organization", async () => {
        const { db, reads, writes } = fakeDatabase(lockAll(MANAGED_KEYS));

        await saveAiUserPreferences(db, null, "user_1", { autoApproveLowRisk: true }, null);
        await saveUserSettings(db, null, "user_1", { dailyBriefEnabled: true }, null);

        expect(reads).toEqual([]);
        expect(writes).toEqual(["insert aiUserPreferences", "insert userSettings"]);
    });
});
