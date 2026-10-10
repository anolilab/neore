import { MODEL_REGISTRY } from "@neore/ai/models";
import { describe, expect, it, vi } from "vitest";

import { localizeModelDescription, MODEL_DESCRIPTIONS } from "./model-descriptions";

// The unit-test transform does not compile Lingui macros (vi.mock is hoisted).
vi.mock("@lingui/core/macro", () => {
    return {
        msg: (strings: TemplateStringsArray) => {
            return { id: strings.join("") };
        },
    };
});

/** Stands in for `i18n._`: marks what went through translation. */
const translate = (descriptor: { id?: string }) => `«${descriptor.id ?? ""}»`;

describe(localizeModelDescription, () => {
    it("has a descriptor for every registry description, carrying the same English", () => {
        const missing = MODEL_REGISTRY.flatMap((model) => (model.desc && !Object.hasOwn(MODEL_DESCRIPTIONS, model.desc) ? [model.id] : []));

        expect(missing).toStrictEqual([]);

        for (const [english, descriptor] of Object.entries(MODEL_DESCRIPTIONS)) {
            expect(descriptor.id).toBe(english);
        }
    });

    it("translates a known description", () => {
        expect(localizeModelDescription("Fastest, most affordable Claude model", translate)).toBe("«Fastest, most affordable Claude model»");
    });

    it("falls back to the English text for an unknown description", () => {
        expect(localizeModelDescription("A model added after the catalog", translate)).toBe("A model added after the catalog");
        expect(localizeModelDescription("toString", translate)).toBe("toString");
        expect(localizeModelDescription(undefined, translate)).toBeUndefined();
    });
});
