import { useLingui } from "@lingui/react/macro";
import { createFileRoute } from "@tanstack/react-router";
import type { CSSProperties } from "react";

import RouteErrorBoundary from "@/components/error-boundaries/route-error-boundary";
import CodeShell from "@/features/code/components/code-shell";
import SiteHeader from "@/features/layout/components/site-header";

const HEADER_STYLE = { "--header-height": "calc(var(--spacing) * 10)" } as CSSProperties;

const CodePage = () => {
    const { t } = useLingui();

    return (
        <div className="flex h-full min-h-0 w-full flex-col" style={HEADER_STYLE}>
            <SiteHeader notch={false} title={t`Code`} workspaceSwitch />
            <div className="flex min-h-0 flex-1">
                <CodeShell />
            </div>
        </div>
    );
};

export const Route = createFileRoute("/_shortcut/code/")({
    component: () => (
        <RouteErrorBoundary routeName="/code">
            <CodePage />
        </RouteErrorBoundary>
    ),
});
