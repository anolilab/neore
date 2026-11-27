import { LunoraError } from "lunorash/server";
import { describe, expect, it, vi } from "vitest";

import { BundleImportError } from "../skills/bundle-plan";
import { childOps, importFailure } from "./install-ops";

vi.mock("../_generated/internal", () => {
    return {
        internal: {
            chat: { group: { functions: { createPluginGroupChat: "createGroup" } } },
            plugins: { install_steps: { recordCreated: "recordCreated" }, repair_resume: { holdsLease: "holds" } },
            skills: { bundle: { removeImportedItem: "remove" }, create_skill: { createPluginSkill: "createSkill" } },
            triggers: { functions: { createPluginTrigger: "createTrigger" } },
        },
    };
});

const SKILL = { description: "d", instructions: "i", name: "n", slug: "n" } as never;

describe("child operations", () => {
    it("deletes nothing once its lease was taken over, so a newer repair keeps the children it adopted", async () => {
        const calls: string[] = [];
        const runMutation = vi.fn(async (ref: string) => {
            calls.push(ref);

            if (ref === "recordCreated" && calls.filter((call) => call === "recordCreated").length === 2) {
                throw new LunoraError("CONFLICT", "STALE_LEASE: this install was taken over by another action");
            }

            if (ref === "holds") {
                return true;
            }

            return ref === "createSkill" ? `skill-${String(calls.length)}` : null;
        });
        const ops = childOps({ runMutation } as never, {
            generation: 1,
            installId: "install",
            intentFor: async () => "intent",
            isPremium: true,
            userId: "owner",
            version: "1.0.0",
        });

        await ops.createSkill(SKILL, "skill:a");
        await expect(ops.createSkill(SKILL, "skill:b")).rejects.toThrow("STALE_LEASE");
        await ops.deleteSkill("skill-1");

        expect(calls).not.toContain("remove");
    });

    const opsWith = (runMutation: (ref: string) => Promise<unknown>) =>
        childOps({ runMutation } as never, {
            generation: 1,
            installId: "install",
            intentFor: async () => "intent",
            isPremium: true,
            userId: "owner",
            version: "1.0.0",
        });

    it("removes a child it created when linking it fails, so a clean rollback leaves no orphan", async () => {
        const calls: string[] = [];
        const ops = opsWith(async (ref) => {
            calls.push(ref);

            if (ref === "recordCreated") {
                throw new Error("database busy");
            }

            if (ref === "holds") {
                return true;
            }

            return ref === "createSkill" ? "skill-1" : { kept: false };
        });

        await expect(ops.createSkill(SKILL, "skill:a")).rejects.toThrow("database busy");
        expect(calls).toEqual(["createSkill", "recordCreated", "remove"]);
    });

    it("names the child in leftBehind when it cannot be removed after a failed link", async () => {
        const ops = opsWith(async (ref) => {
            if (ref === "recordCreated" || ref === "remove") {
                throw new Error("database busy");
            }

            return ref === "holds" ? true : "skill-1";
        });

        await expect(ops.createSkill(SKILL, "skill:a")).rejects.toMatchObject({ leftBehind: ["skill:a"], name: "BundleImportError" });
    });

    it("keeps a child whose link failed because the lease was lost", async () => {
        const calls: string[] = [];
        const ops = opsWith(async (ref) => {
            calls.push(ref);

            if (ref === "recordCreated") {
                throw new LunoraError("CONFLICT", "STALE_LEASE: this install was taken over by another action");
            }

            return "skill-1";
        });

        await expect(ops.createSkill(SKILL, "skill:a")).rejects.toThrow("STALE_LEASE");
        expect(calls).not.toContain("remove");
    });

    it("deletes nothing when another action holds the install by now, even though no step reported a stale lease", async () => {
        const calls: string[] = [];
        const ops = opsWith(async (ref) => {
            calls.push(ref);

            return ref === "holds" ? false : null;
        });

        await ops.deleteSkill("skill-1");

        expect(calls).toEqual(["holds"]);
    });

    it("deletes while it still holds the lease", async () => {
        const runMutation = vi.fn(async (ref: string) => (ref === "holds" ? true : null));
        const ops = childOps({ runMutation } as never, {
            generation: 1,
            installId: "install",
            intentFor: async () => "intent",
            isPremium: true,
            userId: "owner",
            version: "1.0.0",
        });

        await ops.deleteSkill("skill-1");

        expect(runMutation).toHaveBeenCalledWith("remove", { id: "skill-1", kind: "skill", userId: "owner" });
    });
});

describe("importFailure", () => {
    it("keeps the rate-limit code and its retry hint on a resumable failure", () => {
        const limit = new LunoraError("TOO_MANY_REQUESTS", "Rate limit exceeded.", { data: { retryAfterMs: 1500 } });
        const failure = importFailure(new BundleImportError("kept", [], true, limit)) as LunoraError;

        expect(failure.code).toBe("TOO_MANY_REQUESTS");
        expect(failure.data).toMatchObject({ retryAfterMs: 1500 });
    });

    it("reports any other import failure as a bad request", () => {
        expect((importFailure(new BundleImportError("could not import", [])) as LunoraError).code).toBe("BAD_REQUEST");
    });
});
