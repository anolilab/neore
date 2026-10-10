import type { I18n, MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";

/** Display names for the catalogue's `category` values (`backend/lunora/connectors/seed.ts`); the values stay the keys. */
const CONNECTOR_CATEGORY_LABELS: Record<string, MessageDescriptor> = {
    communication: msg`Communication`,
    development: msg`Development`,
    productivity: msg`Productivity`,
};

/** The translated name of a connector category, or the raw value for one this list does not know yet. */
const connectorCategoryLabel = (category: string, i18n: Pick<I18n, "_">): string => {
    const label = CONNECTOR_CATEGORY_LABELS[category];

    return label ? i18n._(label) : category;
};

export default connectorCategoryLabel;
