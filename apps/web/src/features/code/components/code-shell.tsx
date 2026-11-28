import { Trans, useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import cn from "@neore/ui/utils/cn";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeftIcon } from "lucide-react";
import type { FC, ReactNode } from "react";
import { useEffect, useState } from "react";

import SettingsLink from "@/components/settings/settings-link";
import CodeSetup from "@/features/code/components/code-setup";
import CodeWorkspace from "@/features/code/components/code-workspace";
import { useCodeModeEnabled } from "@/features/code/hooks/use-code-mode-enabled";
import { useCodeSetup } from "@/features/code/hooks/use-code-setup";
import { hostTabId } from "@/features/code/lib/layout";
import { useCodeLayoutStore } from "@/features/code/stores/code-layout-store";
import { isDeviceOnline } from "@/features/devices/lib/device-relay";
import { useCRPC } from "@/lib/lunora/crpc";

const useDevices = (enabled: boolean) => {
    const crpc = useCRPC();

    return useQuery({ ...crpc.devices.functions.listDevices.queryOptions({}), enabled });
};

const ROW =
    "flex min-h-11 w-full items-center gap-2 rounded-lg px-2 text-left text-sm outline-none hover:bg-surface-row-hover focus-visible:ring-2 focus-visible:ring-ring/50 md:min-h-9";

const useNow = (): number => {
    const [now, setNow] = useState(() => Date.now());

    useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 30_000);

        return () => clearInterval(timer);
    }, []);

    return now;
};

const Section: FC<{ children: ReactNode; id: string; title: string }> = ({ children, id, title }) => (
    <section aria-labelledby={id} className="space-y-1 p-3">
        <h2 className="text-muted-foreground px-2 font-mono text-xs" id={id}>
            {title}
        </h2>
        {children}
    </section>
);

type Devices = NonNullable<ReturnType<typeof useDevices>["data"]>;

const HostsSection: FC<{ devices: Devices | undefined; now: number; onSelect: (id: string) => void; selected: string | undefined }> = ({
    devices,
    now,
    onSelect,
    selected,
}) => {
    const { t } = useLingui();

    return (
        <Section id="code-hosts" title={t`Hosts`}>
            {devices && devices.length === 0 && (
                <p className="text-muted-foreground px-2 text-sm">
                    <Trans>No paired computer yet.</Trans>{" "}
                    <SettingsLink className="text-foreground underline underline-offset-2" tab="chat-devices">
                        <Trans>Pair one in Settings</Trans>
                    </SettingsLink>
                </p>
            )}
            <ul className="space-y-0.5">
                {devices?.map((device) => {
                    const online = isDeviceOnline(device.lastSeenAt, now);

                    return (
                        <li key={device._id}>
                            <button
                                aria-pressed={selected === device._id}
                                className={cn(ROW, selected === device._id && "bg-surface-row-active")}
                                onClick={() => onSelect(device._id)}
                                type="button"
                            >
                                <span aria-hidden="true" className={cn("size-2 shrink-0 rounded-full", online ? "bg-success" : "bg-muted-foreground/40")} />
                                <span className="min-w-0 flex-1 truncate">{device.name}</span>
                                <span className="text-muted-foreground text-xs">{online ? t`Online` : t`Offline`}</span>
                            </button>
                        </li>
                    );
                })}
            </ul>
        </Section>
    );
};

const PullRequestsSection: FC = () => {
    const { t } = useLingui();

    return (
        <Section id="code-pull-requests" title={t`Pull requests`}>
            <p className="text-muted-foreground px-2 text-sm">
                <Trans>Connect a Git host to review pull requests here.</Trans>{" "}
                <SettingsLink className="text-foreground underline underline-offset-2" tab="connectors">
                    <Trans>Open Connectors</Trans>
                </SettingsLink>
            </p>
        </Section>
    );
};

const RunsSection: FC = () => {
    const { t } = useLingui();

    return (
        <Section id="code-runs" title={t`Coding agent runs`}>
            <p className="text-muted-foreground px-2 text-sm">
                <Trans>Runs you start from a chat appear here.</Trans>
            </p>
        </Section>
    );
};

/** The /code workspace: a navigation column and a main area that item 3 fills with panes. */
const CodeShell: FC = () => {
    const { t } = useLingui();
    const enabled = useCodeModeEnabled();
    // On a phone the list and the workspace take turns. Until the user picks, the list opens first only when it has a paired
    // host to pick; otherwise the workspace (the setup steps, or its loading state) comes first.
    const [listChoice, setListChoice] = useState<boolean | undefined>(undefined);
    const [setupInList, setSetupInList] = useState(false);
    const now = useNow();
    const dispatch = useCodeLayoutStore((state) => state.dispatch);
    const activeTab = useCodeLayoutStore((state) => state.layout.panes[state.layout.activePane]?.active);
    const { data: devices, isError: devicesFailed } = useDevices(enabled === true);
    const setup = useCodeSetup(devices, devicesFailed);

    if (enabled === undefined) {
        return null;
    }

    if (!enabled) {
        return (
            <div className="flex flex-1 items-center justify-center p-6">
                <p className="text-muted-foreground text-sm">
                    <Trans>Code mode is not available for your account yet.</Trans>
                </p>
            </div>
        );
    }

    // A device still waiting for its pairing to be confirmed has never been seen, and is not a host to pick yet.
    const hasPairedHost = devices?.some((device) => device.lastSeenAt !== undefined) === true;
    const listOpen = listChoice ?? hasPairedHost;
    const selectedId = activeTab?.startsWith("host:") ? activeTab.slice("host:".length) : undefined;
    const openHost = (id: string) => {
        dispatch({ tabId: hostTabId(id), type: "open" });
        setListChoice(false);
    };

    return (
        <>
            <aside
                aria-label={t`Code navigation`}
                className={cn("bg-background border-border/50 w-full shrink-0 overflow-y-auto md:block md:w-72 md:border-r", listOpen ? "block" : "hidden")}
            >
                {setup === "needed" && (
                    // On a phone the steps open here in the list: the workspace may hold a host tab, and the steps show only in an
                    // empty pane.
                    <div className="p-2 md:hidden">
                        <Button aria-expanded={setupInList} className="min-h-11" onClick={() => setSetupInList((open) => !open)} variant="outline">
                            {t`Coding setup`}
                        </Button>
                        {setupInList && <CodeSetup devices={devices ?? []} />}
                    </div>
                )}
                <HostsSection devices={devices} now={now} onSelect={openHost} selected={selectedId} />
                <PullRequestsSection />
                <RunsSection />
            </aside>
            <div className={cn("min-w-0 flex-1 flex-col md:flex", listOpen ? "hidden" : "flex")}>
                <div className="p-2 md:hidden">
                    <Button className="min-h-11" onClick={() => setListChoice(true)} variant="ghost">
                        <ArrowLeftIcon aria-hidden="true" className="size-4" />
                        <Trans>Back</Trans>
                    </Button>
                </div>
                <CodeWorkspace devices={devices} now={now} setup={setup} />
            </div>
        </>
    );
};

export default CodeShell;
