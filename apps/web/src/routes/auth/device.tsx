import { msg } from "@lingui/core/macro";
import { createFileRoute, useLocation } from "@tanstack/react-router";

import { DeviceApproval } from "@/features/auth/components/device-approval";
import { seo } from "@/lib/seo";

/**
 * Approve a sign-in started by `neore login --device`; the page itself is `DeviceApproval`.
 *
 * The code is read from the raw query string: the router JSON-parses search values, which turns a code like
 * `23456789` into a number and `2E345678` into `Infinity`.
 */
interface DeviceSearch {
    user_code?: string;
}

const DeviceRoute = () => {
    const navigate = Route.useNavigate();
    const searchString = useLocation({ select: (location) => location.searchStr });
    const rawCode = new URLSearchParams(searchString).get("user_code") ?? undefined;

    return (
        <DeviceApproval
            onCode={(code) => {
                navigate({ search: { user_code: code } }).catch(() => undefined);
            }}
            rawCode={rawCode}
        />
    );
};

export const Route = createFileRoute("/auth/device")({
    component: DeviceRoute,
    validateSearch: (search: Record<string, unknown>): DeviceSearch => {
        return { user_code: search.user_code === undefined ? undefined : String(search.user_code) };
    },
    head: ({ match }) => {
        return {
            meta: seo({ noIndex: true, title: match.context.i18n._(msg`Sign in the command line`) }),
        };
    },
});
