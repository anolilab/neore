"use client";

import { useLingui } from "@lingui/react/macro";
import { buttonVariants } from "@neore/ui/components/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@neore/ui/components/empty";
import cn from "@neore/ui/utils/cn";
import { Link } from "@tanstack/react-router";
import { GitPullRequest } from "lucide-react";

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
            <Link className={cn(buttonVariants())} to="/dashboard/settings/connectors">
                {t`Connect ${label}`}
            </Link>
        </Empty>
    );
};

export default ConnectHostCard;
