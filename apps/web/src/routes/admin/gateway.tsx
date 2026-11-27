import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import cn from "@neore/ui/utils/cn";
import { createFileRoute, Link, Outlet } from "@tanstack/react-router";
import { LineChart } from "lucide-react";

const tabs = [{ icon: LineChart, label: msg`Analytics`, to: "/admin/gateway/" }] as const;

// The settings navigation's rows: the open section in a soft well (pressed-in in light, a lifted row in dark).
const activeLinkClass = "bg-surface-well dark:bg-surface-row-active text-foreground";
const inactiveLinkClass = "text-muted-foreground hover:bg-surface-row-hover hover:text-foreground";

const GatewayLayoutPage = () => {
    const { i18n, t } = useLingui();

    return (
        <div className="space-y-6">
            <div>
                <h2 className="text-[15px] font-semibold">
                    <Trans>LLM Gateway</Trans>
                </h2>
                <p className="text-muted-foreground mt-1 text-sm">
                    <Trans>Smart routing, model usage, and provider health</Trans>
                </p>
            </div>

            <nav aria-label={t`Gateway sections`}>
                <ul className="flex gap-1">
                    {tabs.map((tab) => (
                        <li key={tab.to}>
                            <Link
                                activeOptions={{ exact: true }}
                                activeProps={{ "aria-current": "page" as const, className: activeLinkClass }}
                                className={cn("flex h-8 items-center gap-2 rounded-lg px-3 text-sm transition-colors", inactiveLinkClass)}
                                inactiveProps={{ className: inactiveLinkClass }}
                                to={tab.to}
                            >
                                <tab.icon aria-hidden="true" className="size-4" />
                                {i18n._(tab.label)}
                            </Link>
                        </li>
                    ))}
                </ul>
            </nav>

            <Outlet />
        </div>
    );
};

export const Route = createFileRoute("/admin/gateway")({
    component: GatewayLayoutPage,
});
