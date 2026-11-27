import { LunoraError } from "lunorash/server";
import { describe, expect, it, vi } from "vitest";

import { BundleImportError } from "../skills/bundle-plan";
import { childOps, importFailure } from "./install-ops";

vi.mock("../_generated/internal", () => {
    return {
        internal: {
            chat: { group: { functions: { createPluginGroupChat: "createGroup" } } },
            plugins: { install_steps: { recordCreated: "recordCreated" } },
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

    it("deletes while it still holds the lease", async () => {
        const runMutation = vi.fn(async () => null);
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
