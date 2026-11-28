import { useLingui } from "@lingui/react/macro";
import { Button, buttonVariants } from "@neore/ui/components/button";
import type { FC } from "react";

import SettingsLink from "@/components/settings/settings-link";
import { useDevelopHost } from "@/features/develop/lib/use-develop";
import SetupStepRow from "@/features/onboarding/components/setup-step-row";

/**
 * The "connect a Git host" row of the Code setup list. Done once the account has a grant; there is nothing to skip.
 * `withAction` is off where settings cannot open on top of the page, such as the welcome dialog.
 */
const GitHostStep: FC<{ withAction?: boolean }> = ({ withAction = true }) => {
    const { t } = useLingui();
    const title = t`Connect a Git host`;
    const host = useDevelopHost();
    // A failed read wins over what the cache still holds: the query does not retry by itself, so the row offers it.
    const failed = host.isError;
    const connected = !failed && host.data?.connected === true;
    let statusLabel = t`To do`;

    if (failed) {
        statusLabel = t`Could not check`;
    } else if (connected) {
        statusLabel = t`Done`;
    } else if (host.data === undefined) {
        statusLabel = t`Checking`;
    }

    return (
        <SetupStepRow description={t`Connect a Git host to review pull requests here.`} done={connected} statusLabel={statusLabel} title={title}>
            {failed && (
                // Said once as it fails, like the other steps' changes: a user already on the page would not see the row change.
                <span className="sr-only" role="alert">
                    {t`${title} could not be checked.`}
                </span>
            )}
            {failed && (
                <Button
                    disabled={host.isFetching}
                    onClick={() => {
                        host.refetch().catch(() => {});
                    }}
                    size="sm"
                    variant="ghost"
                >
                    {t`Retry`}
                    <span className="sr-only">: {t`Connect a Git host`}</span>
                </Button>
            )}
            {!connected && withAction && (
                <SettingsLink className={buttonVariants({ size: "sm", variant: "outline" })} tab="connectors">
                    {t`Open Connectors`}
                    <span className="sr-only">: {t`Connect a Git host`}</span>
                </SettingsLink>
            )}
        </SetupStepRow>
    );
};

export default GitHostStep;
