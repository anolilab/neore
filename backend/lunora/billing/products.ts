/** The configured Creem products, read from the environment. Shared by checkout and the webhook so they cannot disagree. */
import { CREEM_PRODUCT_PRO, CREEM_PRODUCT_PRO_YEARLY, CREEM_PRODUCT_TEAM, CREEM_PRODUCT_TEAM_YEARLY, CREEM_YEARLY_CHECKOUT } from "../env";
import type { PlanProducts } from "./plans";

/**
 * One product id may sell one plan at one interval, and no other. A shared id makes yearly checkout buy the monthly
 * product, or classifies a Team subscription as Pro, so a collision throws rather than picking one silently.
 */
const assertDistinctProducts = (products: PlanProducts): void => {
    const ids = [products.pro, products.team, products.yearly?.pro, products.yearly?.team].filter((id): id is string => Boolean(id));
    const shared = ids.find((id, index) => ids.indexOf(id) !== index);

    if (shared !== undefined) {
        throw new Error(`Creem product ${shared} is set for more than one plan or interval. Each CREEM_PRODUCT_* id must be unique.`);
    }
};

/** Every configured product, for recognising subscriptions in webhook events. Never narrowed by checkout availability. */
export const planProducts = (): PlanProducts => {
    const products: PlanProducts = {
        pro: CREEM_PRODUCT_PRO,
        team: CREEM_PRODUCT_TEAM,
        yearly: { pro: CREEM_PRODUCT_PRO_YEARLY, team: CREEM_PRODUCT_TEAM_YEARLY },
    };

    assertDistinctProducts(products);

    return products;
};

/** The products a NEW checkout may use: yearly only while `CREEM_YEARLY_CHECKOUT` is on. */
export const checkoutProducts = (): PlanProducts => {
    const products = planProducts();

    return CREEM_YEARLY_CHECKOUT === "true" ? products : { pro: products.pro, team: products.team };
};
