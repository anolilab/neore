/** The configured Creem products, read from the environment. Shared by checkout and the webhook so they cannot disagree. */
import { CREEM_PRODUCT_PRO, CREEM_PRODUCT_PRO_YEARLY, CREEM_PRODUCT_TEAM, CREEM_PRODUCT_TEAM_YEARLY, CREEM_YEARLY_CHECKOUT } from "../env";
import { logger } from "../lib/logger";
import type { PlanProducts } from "./plans";

const billingLogger = logger.scope("billing");

const configuredProducts = (): PlanProducts => ({
    pro: CREEM_PRODUCT_PRO,
    team: CREEM_PRODUCT_TEAM,
    yearly: { pro: CREEM_PRODUCT_PRO_YEARLY, team: CREEM_PRODUCT_TEAM_YEARLY },
});

/** Every id that appears more than once. An empty id is unconfigured, not a collision. */
const repeatedIds = (products: PlanProducts): ReadonlySet<string> => {
    const ids = [products.pro, products.team, products.yearly?.pro, products.yearly?.team].filter((id): id is string => Boolean(id));

    return new Set(ids.filter((id, index) => ids.indexOf(id) !== index));
};

/** The same products with every repeated id blanked, so it matches no subscription. */
const withoutIds = (products: PlanProducts, drop: ReadonlySet<string>): PlanProducts => {
    const keep = (id: string): string => (drop.has(id) ? "" : id);

    return {
        pro: keep(products.pro),
        team: keep(products.team),
        yearly: { pro: keep(products.yearly?.pro ?? ""), team: keep(products.yearly?.team ?? "") },
    };
};

/**
 * The products a NEW checkout may use: yearly only while `CREEM_YEARLY_CHECKOUT` is on. A repeated id throws here,
 * because checkout would otherwise sell the wrong plan.
 */
export const checkoutProducts = (): PlanProducts => {
    const products = configuredProducts();
    const repeated = repeatedIds(products);

    if (repeated.size > 0) {
        throw new Error(`Creem product ${[...repeated][0]} is set for more than one plan or interval. Each CREEM_PRODUCT_* id must be unique.`);
    }

    return CREEM_YEARLY_CHECKOUT === "true" ? products : { pro: products.pro, team: products.team };
};

/**
 * Every configured product, for recognising subscriptions in webhook events. Never narrowed by checkout availability.
 * A repeated id recognises nothing and is logged: the webhook has already stored the event, so throwing here would fail
 * the monthly grants and cancellations that share the rest of the configuration.
 */
export const planProducts = (): PlanProducts => {
    const products = configuredProducts();
    const repeated = repeatedIds(products);

    if (repeated.size === 0) {
        return products;
    }

    billingLogger.error("Creem product ids repeat; events for those products grant nothing", { productIds: [...repeated] });

    return withoutIds(products, repeated);
};
