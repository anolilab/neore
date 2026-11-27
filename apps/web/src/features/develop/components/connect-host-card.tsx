"use client";

import { useLingui } from "@lingui/react/macro";
import { buttonVariants } from "@neore/ui/components/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@neore/ui/components/empty";
import cn from "@neore/ui/utils/cn";
import { GitPullRequest } from "lucide-react";

import SettingsLink from "@/components/settings/settings-link";

/** The call to action for a user who has not connected the host. Not an error: nothing failed. */
const ConnectHostCard = ({ label }: { label: string }) => {
    const { t } = useLingui();

    return (
        <Empty>
            <EmptyHeader>
                <EmptyMedia variant="icon">
                    <GitPullRequest aria-hidden />
                </EmptyMedia>
                <EmptyTitle>{t`Connect ${label}`}</EmptyTitle>
                <EmptyDescription>{t`Connect your ${label} account to see what needs your review, what is yours, and what is ready to merge.`}</EmptyDescription>
            </EmptyHeader>
            <SettingsLink className={cn(buttonVariants())} tab="connectors">
                {t`Connect ${label}`}
            </SettingsLink>
        </Empty>
    );
};

export default ConnectHostCard;
