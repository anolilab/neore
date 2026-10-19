/** The configured Creem products, read from the environment. Shared by checkout and the webhook so they cannot disagree. */
import { CREEM_PRODUCT_PRO, CREEM_PRODUCT_PRO_YEARLY, CREEM_PRODUCT_TEAM, CREEM_PRODUCT_TEAM_YEARLY } from "../env";
import type { PlanProducts } from "./plans";

export const planProducts = (): PlanProducts => {
    return {
        pro: CREEM_PRODUCT_PRO,
        team: CREEM_PRODUCT_TEAM,
        yearly: { pro: CREEM_PRODUCT_PRO_YEARLY, team: CREEM_PRODUCT_TEAM_YEARLY },
    };
};
