import { describe, expect, it } from "vitest";

import type { BundleItem, BundleTrigger } from "./bundle-format";
import { buildBundleMarkdown, parseBundleMarkdown } from "./bundle-format";
import type { PlanEnv } from "./bundle-plan";
import { planBundle } from "./bundle-plan";

const HASH = "a".repeat(64);

/** Turns a plain bundle into a plugin file: the same body, with the `bundle: 2` header. */
const asPlugin = (body: string): string => body.replace("bundle: 1\n", `bundle: 2\nplugin: keys-plugin\npluginVersion: 1.0.0\ncontentHash: ${HASH}\n`);

const ANALYST = { description: "Analyst skill", instructions: "Be the analyst.", name: "Analyst", slug: "analyst" };
const CRITIC = { description: "Critic skill", instructions: "Be the critic.", name: "Critic", slug: "critic" };
const WEEKLY: BundleTrigger = { cronExpression: "0 9 * * 1", model: "anthropic/claude-sonnet-5", name: "Weekly digest", type: "schedule" };

describe("declared keys in a bundle", () => {
    it("a plugin file reads each section's declared key, and its label without the key", () => {
        const body = buildBundleMarkdown({
            description: "",
            items: [
                { key: "analyst", kind: "skill", skill: ANALYST },
                { key: "digest", kind: "trigger", trigger: WEEKLY },
            ],
            name: "Keys",
        });

        const parsed = parseBundleMarkdown(asPlugin(body));

        expect(parsed.ok).toBe(true);

        if (!parsed.ok) {
            return;
        }

        expect(parsed.bundle.entries.map((entry) => [entry.kind, entry.declaredKey, entry.label, entry.problems])).toStrictEqual([
            ["skill", "analyst", "analyst", []],
            ["trigger", "digest", "Weekly digest", []],
        ]);
    });

    it("a label that ends in a key-shaped text reads back intact, because the declared key is the last attribute", () => {
        const body = buildBundleMarkdown({
            description: "",
            items: [{ key: "digest", kind: "trigger", trigger: { ...WEEKLY, name: "Weekly {key=old}" } }],
            name: "Keys",
        });

        const parsed = parseBundleMarkdown(asPlugin(body));

        expect(parsed.ok && parsed.bundle.entries[0]).toMatchObject({ declaredKey: "digest", label: "Weekly {key=old}" });
    });

    it("a plugin section without a key fails the whole file", () => {
        const body = buildBundleMarkdown({ description: "", items: [{ kind: "skill", skill: ANALYST }], name: "Keys" });

        const parsed = parseBundleMarkdown(asPlugin(body));

        expect(parsed.ok).toBe(false);
        expect(parsed.ok ? "" : parsed.errors.join(" ")).toContain("has no key");
    });

    it("a declared key must be lowercase letters, digits and dashes, starting with a letter", () => {
        for (const key of ["0", "Analyst", "bad_key", "-lead"]) {
            const body = buildBundleMarkdown({ description: "", items: [{ key, kind: "skill", skill: ANALYST }], name: "Keys" });

            const parsed = parseBundleMarkdown(asPlugin(body));

            expect(parsed.ok, key).toBe(false);
            expect(parsed.ok ? "" : parsed.errors.join(" "), key).toContain("not lowercase letters");
        }
    });

    it("two items of one kind cannot share a key, but a skill and a trigger may", () => {
        const shared = buildBundleMarkdown({
            description: "",
            items: [
                { key: "same", kind: "skill", skill: ANALYST },
                { key: "same", kind: "skill", skill: CRITIC },
            ],
            name: "Keys",
        });
        const mixed = buildBundleMarkdown({
            description: "",
            items: [
                { key: "same", kind: "skill", skill: ANALYST },
                { key: "same", kind: "trigger", trigger: WEEKLY },
            ],
            name: "Keys",
        });

        const duplicate = parseBundleMarkdown(asPlugin(shared));

        expect(duplicate.ok).toBe(false);
        expect(duplicate.ok ? "" : duplicate.errors.join(" ")).toContain('share the key "same"');
        expect(parseBundleMarkdown(asPlugin(mixed)).ok).toBe(true);
    });

    it("a plain bundle takes a brace-key in a label as written, since it declares no keys", () => {
        const body = buildBundleMarkdown({
            description: "",
            items: [{ kind: "trigger", trigger: { ...WEEKLY, name: "Weekly {key=old}" } }],
            name: "Plain",
        });

        const parsed = parseBundleMarkdown(body);

        expect(parsed.ok && parsed.bundle.entries[0]).toMatchObject({ declaredKey: undefined, label: "Weekly {key=old}", problems: [] });
    });

    it("a trigger keeps its key when a skill is inserted above it, so an unedited schedule is not recreated", () => {
        const env: PlanEnv = {
            existingSkillCount: 0,
            existingSlugs: new Set<string>(),
            isKnownTool: () => true,
            isModelRunnable: () => true,
            now: Date.UTC(2026, 10, 12),
            skillLimit: undefined,
        };
        const keysOf = (items: BundleItem[]): string[] => {
            const parsed = parseBundleMarkdown(asPlugin(buildBundleMarkdown({ description: "", items, name: "Keys" })));

            if (!parsed.ok) {
                throw new Error(parsed.errors.join(" "));
            }

            return planBundle(parsed.bundle, undefined, env).map((entry) => entry.key);
        };

        const before = keysOf([
            { key: "analyst", kind: "skill", skill: ANALYST },
            { key: "digest", kind: "trigger", trigger: WEEKLY },
        ]);
        const after = keysOf([
            { key: "critic", kind: "skill", skill: CRITIC },
            { key: "analyst", kind: "skill", skill: ANALYST },
            { key: "digest", kind: "trigger", trigger: WEEKLY },
        ]);

        expect(before).toContain("trigger:digest");
        expect(after).toContain("trigger:digest");
    });
});
