import type { GatewayModel } from "@neore/ai/models";
import { requiresPaidPlan } from "@neore/ai/models";

/**
 * The models a backup picker may offer: the run's own paid-model rule. A paid-plan model needs a plan that
 * opens them (`canRunPaidModels`, from the backend's `getPaidModelAccess`) or the user's own key for the
 * model's provider. The save re-checks on the server, so this only keeps the list honest.
 */
export const offerableBackupModels = (models: GatewayModel[], canRunPaidModels: boolean, providersWithKey: ReadonlySet<string>): GatewayModel[] =>
    models.filter((model) => !requiresPaidPlan(model) || canRunPaidModels || providersWithKey.has(model.provider ?? ""));

/** `backupModels` with `id` moved one place up (`-1`) or down (`1`); unchanged at either end or when `id` is not in it. */
export const moveBackupModel = (backupModels: ReadonlyArray<string>, id: string, offset: -1 | 1): string[] => {
    const from = backupModels.indexOf(id);
    const to = from + offset;

    if (from === -1 || to < 0 || to >= backupModels.length) {
        return [...backupModels];
    }

    return backupModels.map((entry, index) => {
        if (index === from) {
            return backupModels[to]!;
        }

        return index === to ? id : entry;
    });
};
