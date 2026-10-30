import { Trans, useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@neore/ui/components/resizable";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@neore/ui/components/tabs";
import cn from "@neore/ui/utils/cn";
import { Columns2Icon, XIcon } from "lucide-react";
import type { FC, MouseEvent } from "react";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

import type { CodeHost } from "@/features/code/components/host-details";
import HostDetails from "@/features/code/components/host-details";
import type { Pane } from "@/features/code/lib/layout";
import { hostTabId, MAX_PANES } from "@/features/code/lib/layout";
import { useCodeLayoutStore } from "@/features/code/stores/code-layout-store";

const DESKTOP_QUERY = "(min-width: 768px)";

const subscribeDesktop = (notify: () => void): (() => void) => {
    const media = globalThis.matchMedia(DESKTOP_QUERY);

    media.addEventListener("change", notify);

    return () => media.removeEventListener("change", notify);
};

const useIsDesktop = (): boolean =>
    useSyncExternalStore(
        subscribeDesktop,
        () => globalThis.matchMedia(DESKTOP_QUERY).matches,
        () => true,
    );

const runOnMiddleClick = (event: MouseEvent, action: () => void): void => {
    if (event.button !== 1) {
        return;
    }

    event.preventDefault();
    action();
};

const EmptyPane: FC = () => (
    <div className="flex flex-1 flex-col items-center justify-center gap-1 p-6 text-center">
        <h2 className="text-lg font-semibold">
            <Trans>Pick a host or a pull request</Trans>
        </h2>
        <p className="text-muted-foreground text-sm">
            <Trans>Choose one on the left to start.</Trans>
        </p>
    </div>
);

type PaneViewProps = {
    canClose: boolean;
    canSplit: boolean;
    hosts: Map<string, CodeHost>;
    index: number;
    loaded: boolean;
    now: number;
    pane: Pane;
};

const PaneView: FC<PaneViewProps> = ({ canClose, canSplit, hosts, index, loaded, now, pane }) => {
    const { t } = useLingui();
    const dispatch = useCodeLayoutStore((state) => state.dispatch);
    const focus = () => dispatch({ paneIndex: index, type: "focus" });

    if (pane.tabs.length === 0) {
        return (
            <section aria-label={t`Pane ${index + 1}`} className="flex h-full min-w-0 flex-col" onFocusCapture={focus} onPointerDownCapture={focus}>
                {canClose && (
                    <div className="border-border flex justify-end border-b p-1">
                        <Button aria-label={t`Close pane`} onClick={() => dispatch({ paneIndex: index, type: "closePane" })} size="icon-sm" variant="ghost">
                            <XIcon aria-hidden="true" />
                        </Button>
                    </div>
                )}
                <EmptyPane />
            </section>
        );
    }

    const titleOf = (tabId: string): string => {
        const host = hosts.get(tabId);

        if (host) {
            return t`Host: ${host.name}`;
        }

        return loaded ? tabId : t`Loading…`;
    };
    const onMiddleClick = (event: MouseEvent, tabId: string) => runOnMiddleClick(event, () => dispatch({ paneIndex: index, tabId, type: "close" }));

    return (
        <section aria-label={t`Pane ${index + 1}`} className="flex h-full min-w-0 flex-col" onFocusCapture={focus} onPointerDownCapture={focus}>
            <Tabs
                className="min-h-0 flex-1 gap-0"
                onValueChange={(value) => typeof value === "string" && dispatch({ paneIndex: index, tabId: value, type: "activate" })}
                value={pane.active ?? null}
            >
                <div className="border-border flex items-center border-b">
                    <TabsList aria-label={t`Open tabs`} className="min-w-0 flex-1 justify-start overflow-x-auto rounded-none bg-transparent p-0" variant="line">
                        {pane.tabs.map((tabId) => (
                            <div
                                className="flex shrink-0 items-center"
                                key={tabId}
                                onAuxClick={(event) => onMiddleClick(event, tabId)}
                                onMouseDown={(event) => event.button === 1 && event.preventDefault()}
                                role="presentation"
                            >
                                <TabsTrigger
                                    className="min-h-11 flex-none gap-1 px-2 md:min-h-8"
                                    onKeyDown={(event) =>
                                        (event.key === "Delete" || event.key === "Backspace") && dispatch({ paneIndex: index, tabId, type: "close" })
                                    }
                                    value={tabId}
                                >
                                    {titleOf(tabId)}
                                </TabsTrigger>
                                <button
                                    aria-label={t`Close ${titleOf(tabId)}`}
                                    className="hover:bg-muted focus-visible:ring-ring/50 text-muted-foreground flex size-8 items-center justify-center rounded-md outline-none focus-visible:ring-2 md:size-6"
                                    onClick={() => dispatch({ paneIndex: index, tabId, type: "close" })}
                                    tabIndex={-1}
                                    type="button"
                                >
                                    <XIcon aria-hidden="true" className="size-3.5" />
                                </button>
                            </div>
                        ))}
                    </TabsList>
                    <div className="flex shrink-0 items-center gap-0.5 px-1">
                        {canSplit && (
                            <Button
                                aria-label={t`Split right`}
                                className="hidden md:inline-flex"
                                onClick={() => dispatch({ paneIndex: index, type: "split" })}
                                size="icon-sm"
                                title={t`Split right`}
                                variant="ghost"
                            >
                                <Columns2Icon aria-hidden="true" />
                            </Button>
                        )}
                        {canClose && (
                            <Button
                                aria-label={t`Close pane`}
                                onClick={() => dispatch({ paneIndex: index, type: "closePane" })}
                                size="icon-sm"
                                title={t`Close pane`}
                                variant="ghost"
                            >
                                <XIcon aria-hidden="true" />
                            </Button>
                        )}
                    </div>
                </div>
                {pane.tabs.map((tabId) => {
                    const host = hosts.get(tabId);

                    return (
                        <TabsContent className="min-h-0 overflow-y-auto" key={tabId} value={tabId}>
                            {host ? <HostDetails host={host} now={now} /> : <EmptyPane />}
                        </TabsContent>
                    );
                })}
            </Tabs>
        </section>
    );
};

type CodeWorkspaceProps = {
    className?: string;
    /** The devices the shell already loaded; nothing here subscribes again. `undefined` while loading. */
    devices: CodeHost[] | undefined;
    now: number;
};

/** The main area of /code: one or two panes side by side, each with its own tab strip. */
const CodeWorkspace: FC<CodeWorkspaceProps> = ({ className, devices, now }) => {
    const { t } = useLingui();
    const layout = useCodeLayoutStore((state) => state.layout);
    const dispatch = useCodeLayoutStore((state) => state.dispatch);
    const isDesktop = useIsDesktop();
    const [hydrated, setHydrated] = useState(false);

    useEffect(() => {
        void Promise.resolve(useCodeLayoutStore.persist.rehydrate()).then(() => setHydrated(true));
    }, []);

    useEffect(() => {
        if (!(hydrated && devices)) {
            return;
        }

        const known = new Set(devices.map((device) => hostTabId(device._id)));

        dispatch({ isValid: (tabId) => known.has(tabId), type: "prune" });
    }, [devices, dispatch, hydrated]);

    const onLayoutChanged = useCallback(
        (sizes: Record<string, number>) => {
            const first = sizes["pane-0"];

            if (first !== undefined) {
                dispatch({ split: first, type: "resize" });
            }
        },
        [dispatch],
    );

    const hosts = new Map((devices ?? []).map((device) => [hostTabId(device._id), device]));
    const visible = isDesktop ? layout.panes : [layout.panes[layout.activePane] ?? layout.panes[0]!];
    const canSplit = isDesktop && layout.panes.length < MAX_PANES;

    return (
        <div className={cn("flex min-h-0 min-w-0 flex-1 flex-col", className)}>
            <h1 className="sr-only">
                <Trans>Code</Trans>
            </h1>
            {visible.length === 1 ? (
                <PaneView
                    canClose={isDesktop && layout.panes.length > 1}
                    canSplit={canSplit}
                    hosts={hosts}
                    index={isDesktop ? 0 : layout.activePane}
                    loaded={devices !== undefined}
                    now={now}
                    pane={visible[0]!}
                />
            ) : (
                <ResizablePanelGroup
                    className="min-h-0 flex-1"
                    defaultLayout={{ "pane-0": layout.split, "pane-1": 100 - layout.split }}
                    key={String(hydrated)}
                    onLayoutChanged={onLayoutChanged}
                >
                    <ResizablePanel id="pane-0" minSize="20%">
                        <PaneView canClose canSplit={false} hosts={hosts} index={0} loaded={devices !== undefined} now={now} pane={visible[0]!} />
                    </ResizablePanel>
                    <ResizableHandle aria-label={t`Resize panes`} withHandle />
                    <ResizablePanel id="pane-1" minSize="20%">
                        <PaneView canClose canSplit={false} hosts={hosts} index={1} loaded={devices !== undefined} now={now} pane={visible[1]!} />
                    </ResizablePanel>
                </ResizablePanelGroup>
            )}
        </div>
    );
};

export default CodeWorkspace;
