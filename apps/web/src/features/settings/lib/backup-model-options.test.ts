import type { GatewayModel } from "@neore/ai/models";
import { MODEL_REGISTRY, requiresPaidPlan } from "@neore/ai/models";
import { describe, expect, it } from "vitest";

import { moveBackupModel, offerableBackupModels } from "./backup-model-options";

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

describe("moveBackupModel", () => {
    it("swaps a model with its neighbour", () => {
        expect(moveBackupModel(["a", "b", "c"], "b", -1)).toEqual(["b", "a", "c"]);
        expect(moveBackupModel(["a", "b", "c"], "b", 1)).toEqual(["a", "c", "b"]);
    });

    it("leaves the list as it is at either end, or for a model not in it", () => {
        expect(moveBackupModel(["a", "b"], "a", -1)).toEqual(["a", "b"]);
        expect(moveBackupModel(["a", "b"], "b", 1)).toEqual(["a", "b"]);
        expect(moveBackupModel(["a", "b"], "z", 1)).toEqual(["a", "b"]);
    });
});
