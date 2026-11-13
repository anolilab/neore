/**
 * Every permission-cap reader logs a stored policy that no longer parses, so a computer worker or coding-agent task refused
 * for it leaves the same trace as a chat run capped by it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { POLICY_SCHEMA_VERSION, serializeOrganizationPolicy } from "./organization-policy";
import { readOrganizationPermissionCap } from "./permission-cap-read";

const logged = vi.hoisted(() => {
    return { errors: [] as unknown[][] };
});

vi.mock("../../lib/logger", () => {
    return {
        logger: {
            scope: () => {
                return {
                    error: (...args: unknown[]) => {
                        logged.errors.push(args);
                    },
                };
            },
        },
    };
});

/** A database holding `document` as `org-a`'s policy, and no policy for any other organization. */
const contextWith = (document: string | undefined) =>
    ({
        db: {
            organizationPolicies: {
                findFirst: async ({ where }: { where: { organizationId: string } }) =>
                    document !== undefined && where.organizationId === "org-a" ? { document } : null,
            },
        },
    }) as never;

beforeEach(() => {
    logged.errors = [];
});

describe("readOrganizationPermissionCap", () => {
    it("caps an unreadable policy at ask and logs which organization it belongs to", async () => {
        expect(await readOrganizationPermissionCap(contextWith("{not json"), "org-a")).toBe("ask");
        expect(logged.errors).toStrictEqual([[expect.stringContaining("no longer parses"), { organizationId: "org-a" }]]);
    });

    it("reads a stored cap without logging", async () => {
        expect(
            await readOrganizationPermissionCap(
                contextWith(serializeOrganizationPolicy({ permissionCap: "off", schemaVersion: POLICY_SCHEMA_VERSION })),
                "org-a",
            ),
        ).toBe("off");
        expect(logged.errors).toStrictEqual([]);
    });

    it("reads only the asked organization's policy, never another's", async () => {
        const context = contextWith(serializeOrganizationPolicy({ permissionCap: "off", schemaVersion: POLICY_SCHEMA_VERSION }));

        expect(await readOrganizationPermissionCap(context, "org-b")).toBe("auto");
        expect(logged.errors).toStrictEqual([]);
    });

    it("reads the policy from the primary, so a cap an admin just tightened applies to the next run", async () => {
        const reads: unknown[] = [];
        const context = {
            db: {
                organizationPolicies: {
                    findFirst: async (options: unknown) => {
                        reads.push(options);

                        return null;
                    },
                },
            },
        } as never;

        await readOrganizationPermissionCap(context, "org-a");

        expect(reads).toStrictEqual([{ consistency: "primary", where: { organizationId: "org-a" } }]);
    });

    it("gives auto for an organization with no policy, without logging", async () => {
        expect(await readOrganizationPermissionCap(contextWith(undefined), "org-a")).toBe("auto");
        expect(logged.errors).toStrictEqual([]);
    });
});
