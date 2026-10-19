/** The configured Creem products, read from the environment. Shared by checkout and the webhook so they cannot disagree. */
import { CREEM_PRODUCT_PRO, CREEM_PRODUCT_PRO_YEARLY, CREEM_PRODUCT_TEAM, CREEM_PRODUCT_TEAM_YEARLY, CREEM_YEARLY_CHECKOUT } from "../env";
import type { PlanProducts } from "./plans";

/** Every configured product, for recognising subscriptions in webhook events. Never narrowed by checkout availability. */
export const planProducts = (): PlanProducts => {
    return {
        pro: CREEM_PRODUCT_PRO,
        team: CREEM_PRODUCT_TEAM,
        yearly: { pro: CREEM_PRODUCT_PRO_YEARLY, team: CREEM_PRODUCT_TEAM_YEARLY },
    };
};

/** The products a NEW checkout may use: yearly only while `CREEM_YEARLY_CHECKOUT` is on. */
export const checkoutProducts = (): PlanProducts => {
    const products = planProducts();

    return CREEM_YEARLY_CHECKOUT === "true" ? products : { pro: products.pro, team: products.team };
};
