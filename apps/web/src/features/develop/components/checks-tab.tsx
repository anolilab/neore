"use client";

import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { Badge } from "@neore/ui/components/badge";
import { Skeleton } from "@neore/ui/components/skeleton";

import { safeExternalUrl } from "../lib/format";
import type { PullRequestAddress } from "../lib/use-develop";
import { usePullRequestChecks } from "../lib/use-develop";
import FailureNotice from "./failure-notice";

type State = "cancelled" | "failure" | "neutral" | "pending" | "skipped" | "success";

const VARIANT: Record<State, "default" | "destructive" | "outline" | "secondary"> = {
    cancelled: "secondary",
    failure: "destructive",
    neutral: "secondary",
    pending: "outline",
    skipped: "secondary",
    success: "default",
};

const ChecksTab = ({ address, headSha, hostLabel }: { address: PullRequestAddress; headSha: string; hostLabel: string }) => {
    const { t } = useLingui();
    const checks = usePullRequestChecks(address, headSha, true);

    if (checks.isPending) {
        return <Skeleton aria-label={t`Loading checks`} className="h-24 w-full" role="status" />;
    }

    if (checks.isError) {
        return <FailureNotice label={hostLabel} status="host_error" />;
    }

    if (checks.data.status !== "ok") {
        return <FailureNotice label={hostLabel} status={checks.data.status} />;
    }

    const { checks: list, total } = checks.data;

    if (list.length === 0) {
        return <p className="text-muted-foreground text-sm">{t`No checks have run for this commit.`}</p>;
    }

    const labels: Record<State, string> = {
        cancelled: t`Cancelled`,
        failure: t`Failed`,
        neutral: t`Neutral`,
        pending: t`Pending`,
        skipped: t`Skipped`,
        success: t`Passed`,
    };

    return (
        <div className="space-y-3">
            {total > list.length && (
                <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm" role="note">
                    {t`Showing ${list.length} of ${plural(total, { one: "# check", other: "# checks" })}.`}
                </p>
            )}
            <ul className="rounded-md border">
                {list.map((check, index) => {
                    const href = safeExternalUrl(check.url);

                    return (
                        // A check name is not unique across runs and statuses, so the position keeps the key stable.

                        // eslint-disable-next-line react-x/no-array-index-key
                        <li className="flex items-center gap-3 border-b px-3 py-2 text-sm last:border-b-0" key={`${check.name}-${index}`}>
                            <Badge variant={VARIANT[check.state]}>{labels[check.state]}</Badge>
                            {href ? (
                                <a className="min-w-0 flex-1 truncate hover:underline" href={href} rel="noopener noreferrer" target="_blank">
                                    {check.name}
                                </a>
                            ) : (
                                <span className="min-w-0 flex-1 truncate">{check.name}</span>
                            )}
                        </li>
                    );
                })}
            </ul>
        </div>
    );
};

export default ChecksTab;
