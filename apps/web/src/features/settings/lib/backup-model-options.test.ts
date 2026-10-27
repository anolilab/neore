import type { GatewayModel } from "@neore/ai/models";
import { MODEL_REGISTRY, requiresPaidPlan } from "@neore/ai/models";
import { describe, expect, it } from "vitest";

import { offerableBackupModels } from "./backup-model-options";

const text = MODEL_REGISTRY.filter((m) => m.enabled !== false && (m.mode ?? "text") === "text") as unknown as GatewayModel[];
const free = text.find((m) => !requiresPaidPlan(m))!;
const paid = text.find((m) => requiresPaidPlan(m))!;
const idsOf = (models: GatewayModel[]) => models.map((m) => m.id);
const NO_KEYS: ReadonlySet<string> = new Set();
const paidProviderKey: ReadonlySet<string> = new Set([paid.provider ?? ""]);

describe("offerableBackupModels", () => {
    it("hides paid models from a plan that cannot run them", () => {
        const offered = offerableBackupModels([free, paid], false, NO_KEYS);

        expect(idsOf(offered)).toEqual([free.id]);
    });

    it("offers paid models when the backend says the plan opens them", () => {
        const offered = offerableBackupModels([free, paid], true, NO_KEYS);

        expect(idsOf(offered)).toEqual([free.id, paid.id]);
    });

    it("offers a paid model for a provider the user has their own key for", () => {
        const offered = offerableBackupModels([free, paid], false, paidProviderKey);

        expect(idsOf(offered)).toEqual([free.id, paid.id]);
    });
});
