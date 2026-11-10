import { msg } from "@lingui/core/macro";
import { createFileRoute } from "@tanstack/react-router";

import { DeviceApproval } from "@/features/auth/components/device-approval";
import { seo } from "@/lib/seo";

/**
 * Approve a sign-in started by `neore login --device`; the page itself is `DeviceApproval`.
 *
 * A code that reads as a plain number (`23456789`) still arrives as one, so the search is turned back into text here;
 * codes like `2E345678` are kept as written by the router's `parseSearch` (`lib/search-params.ts`).
 */
interface DeviceSearch {
    user_code?: string;
}

const DeviceRoute = () => {
    const navigate = Route.useNavigate();
    const { user_code: rawCode } = Route.useSearch();

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
