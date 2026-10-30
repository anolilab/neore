"use client";

import { useLingui } from "@lingui/react/macro";
import { Alert, AlertDescription, AlertTitle } from "@neore/ui/components/alert";
import { Link } from "@tanstack/react-router";

export type ReadFailureStatus = "forbidden" | "host_error" | "needs_reconnect" | "not_connected" | "not_found" | "rate_limited";

/** What a failed read means to the person, and what to do about it. */
const FailureNotice = ({ label, status }: { label: string; status: ReadFailureStatus }) => {
    const { t } = useLingui();
    const messages: Record<ReadFailureStatus, { description: string; title: string }> = {
        forbidden: {
            description: t`${label} refused this request. Your account may lack access, or an organization may require you to authorize the app.`,
            title: t`No access`,
        },
        host_error: { description: t`${label} could not be reached or answered unexpectedly. Try again in a moment.`, title: t`Could not load this` },
        needs_reconnect: { description: t`Your ${label} sign-in has expired. Connect it again to keep reading.`, title: t`Sign in to ${label} again` },
        not_connected: { description: t`Connect ${label} to read your pull requests here.`, title: t`${label} is not connected` },
        not_found: { description: t`It does not exist, or your ${label} account cannot see it.`, title: t`Not found` },
        rate_limited: { description: t`${label} is limiting requests for this account. Try again in a few minutes.`, title: t`Rate limited` },
    };
    const { description, title } = messages[status];
    const needsConnection = status === "needs_reconnect" || status === "not_connected";

    return (
        <Alert role="alert" variant={needsConnection ? "default" : "destructive"}>
            <AlertTitle>{title}</AlertTitle>
            <AlertDescription>
                {description}
                {needsConnection && (
                    <>
                        {" "}
                        <Link className="text-primary font-medium underline" to="/dashboard/settings/connectors">
                            {t`Open connectors`}
                        </Link>
                    </>
                )}
            </AlertDescription>
        </Alert>
    );
};

export default FailureNotice;
