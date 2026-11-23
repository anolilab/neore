import { DEFAULT_CHAT_MODEL } from "@neore/ai/constants";
import { describe, expect, it } from "vitest";

import { activeRoles, buildRoleCatalog, isRoleModelAllowed, mergeSubAgentRoles, resolveRoleLaunch, roleSystemText, withRole } from "./roles";

const allowAll = () => true;

describe(mergeSubAgentRoles, () => {
    it("lets a project field win and keeps the user's other fields for that role", () => {
        const merged = mergeSubAgentRoles(
            { review: { instructions: "Be terse.", mode: "always", model: "user-model" } },
            { review: { model: "project-model" }, security: { model: "project-security" } },
        );

        expect(merged).toStrictEqual({
            review: { instructions: "Be terse.", mode: "always", model: "project-model" },
            security: { model: "project-security" },
        });
    });

    it("keeps an empty instruction text, which turns the user's off for the project", () => {
        expect(mergeSubAgentRoles({ test: { instructions: "Use vitest." } }, { test: { instructions: "" } })).toStrictEqual({ test: { instructions: "" } });
    });

    it("is empty with nothing set", () => {
        expect(mergeSubAgentRoles(undefined, undefined)).toStrictEqual({});
    });
});

describe(buildRoleCatalog, () => {
    it("is absent until a role has a model: instructions or a mode alone turn nothing on", () => {
        const roles = { research: { instructions: "Cite.", mode: "always" as const } };

        expect(activeRoles(roles)).toStrictEqual([]);
        expect(buildRoleCatalog(roles)).toBeUndefined();
    });

    it("lists the roles with a model and their modes, prefer by default, and never their instructions", () => {
        const catalog = buildRoleCatalog({
            design: { mode: "always" },
            research: { model: "m1" },
            review: { instructions: "SECRET HOUSE RULES", mode: "always", model: "m2" },
        });

        expect(catalog).toContain("- research (prefer):");
        expect(catalog).toContain("- review (always):");
        expect(catalog).not.toContain("design (");
        expect(catalog).not.toContain("SECRET HOUSE RULES");
    });
});

describe(resolveRoleLaunch, () => {
    it("refuses a role without a model, naming the role", () => {
        expect(resolveRoleLaunch({ review: { mode: "always" } }, "review", allowAll)).toStrictEqual({
            error: expect.stringContaining("review role has no model"),
        });
    });

    it("refuses a model the sub-agent rule refuses instead of running on another one", () => {
        expect(resolveRoleLaunch({ review: { model: "gone-model" } }, "review", () => false)).toStrictEqual({
            error: expect.stringContaining("(gone-model) cannot run sub-agents"),
        });
    });

    it("launches with the model, the effort and the user's instructions, dropping blank instructions", () => {
        expect(resolveRoleLaunch({ review: { instructions: "Check auth.", model: "m", reasoningEffort: 80 } }, "review", allowAll)).toStrictEqual({
            role: { instructions: "Check auth.", model: "m", name: "review", reasoningEffort: 80 },
        });
        expect(resolveRoleLaunch({ review: { instructions: " ".repeat(3), model: "m" } }, "review", allowAll)).toStrictEqual({
            role: { model: "m", name: "review" },
        });
    });
});

describe(roleSystemText, () => {
    it("puts the built-in standard first and the user's instructions after it", () => {
        const text = roleSystemText({ instructions: "Check auth.", model: "m", name: "security" });

        expect(text.startsWith("ROLE: security\n")).toBe(true);
        expect(text.indexOf("Check auth.")).toBeGreaterThan(text.indexOf("ROLE: security"));
        expect(text).toContain("THE USER'S INSTRUCTIONS FOR THIS ROLE:");
    });

    it("labels a project owner's instructions as theirs, never as the user's", () => {
        const text = roleSystemText({ instructions: "Check auth.", instructionsBy: "projectOwner", model: "m", name: "security" });

        expect(text).toContain("THE PROJECT OWNER'S INSTRUCTIONS FOR THIS ROLE");
        expect(text).not.toContain("THE USER'S INSTRUCTIONS");
    });
});

describe(withRole, () => {
    it("replaces one role and leaves the others", () => {
        expect(withRole({ research: { model: "a" }, review: { model: "b" } }, "review", { model: "c" })).toStrictEqual({
            research: { model: "a" },
            review: { model: "c" },
        });
    });

    it("removes a role for null or an all-empty config, and leaves {} rather than undefined", () => {
        expect(withRole({ review: { model: "b" } }, "review", null)).toStrictEqual({});
        expect(withRole({ review: { model: "b" } }, "review", {})).toStrictEqual({});
    });
});

describe(isRoleModelAllowed, () => {
    it("allows the default chat model and refuses an unknown id", () => {
        expect(isRoleModelAllowed(DEFAULT_CHAT_MODEL)).toBe(true);
        expect(isRoleModelAllowed("no-such-model")).toBe(false);
    });
});
