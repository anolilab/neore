import { useLingui } from "@lingui/react/macro";
import { buttonVariants } from "@neore/ui/components/button";
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
    const host = useDevelopHost();
    const connected = host.data?.connected === true;
    const pending = host.data === undefined;
    let statusLabel = t`To do`;

    if (connected) {
        statusLabel = t`Done`;
    } else if (pending) {
        statusLabel = host.isError ? t`Could not check` : t`Checking`;
    }

    return (
        <SetupStepRow
            description={t`Connect a Git host to review pull requests here.`}
            done={connected}
            statusLabel={statusLabel}
            title={t`Connect a Git host`}
        >
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
