import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import cn from "@neore/ui/utils/cn";
import { createFileRoute, Link, Outlet } from "@tanstack/react-router";
import { Key, LineChart } from "lucide-react";

const tabs = [
    { icon: LineChart, label: msg`Analytics`, to: "/admin/gateway/" },
    { icon: Key, label: msg`API Keys`, to: "/admin/gateway/keys" },
] as const;

const activeLinkClass = "border-primary text-foreground";
const inactiveLinkClass = "border-transparent text-muted-foreground hover:text-foreground";

const GatewayLayoutPage = () => {
    const { i18n, t } = useLingui();

    return (
        <div className="space-y-6">
            <div>
                <h2 className="text-xl font-semibold">
                    <Trans>LLM Gateway</Trans>
                </h2>
                <p className="text-muted-foreground text-sm">
                    <Trans>Smart routing, model usage, provider health, and virtual API key management</Trans>
                </p>
            </div>

            <nav aria-label={t`Gateway sections`} className="border-b">
                <ul className="flex gap-1">
                    {tabs.map((tab) => (
                        <li key={tab.to}>
                            <Link
                                activeOptions={{ exact: true }}
                                activeProps={{ "aria-current": "page" as const, className: activeLinkClass }}
                                className={cn("flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition-colors", inactiveLinkClass)}
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
