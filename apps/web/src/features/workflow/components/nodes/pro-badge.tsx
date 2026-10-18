import { Trans } from "@lingui/react/macro";

/** The marker on a model row that a free plan cannot run. */
const ProBadge = () => (
    <span className="ml-1 text-xs text-amber-500">
        <Trans>Pro</Trans>
    </span>
);

export default ProBadge;
