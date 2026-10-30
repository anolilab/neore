import { useLingui } from "@lingui/react/macro";
import cn from "@neore/ui/utils/cn";
import { Link, useLocation, useRouter } from "@tanstack/react-router";
import { Code2Icon, MessageSquareIcon } from "lucide-react";
import type { FC } from "react";
import { useEffect } from "react";

import { useCodeModeEnabled } from "@/features/code/hooks/use-code-mode-enabled";
import type { WorkspaceMode } from "@/features/layout/lib/workspace-memory";
import { rememberWorkspaceRoute, workspaceOf, workspaceTarget } from "@/features/layout/lib/workspace-memory";

const ITEM =
    "inline-flex h-6 items-center gap-1.5 rounded-md px-2.5 text-sm font-medium whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-ring/50";

const ROOT_LINKS = { chat: "/chat", code: "/code" } as const satisfies Record<WorkspaceMode, string>;

const store = (): Storage | undefined => (typeof sessionStorage === "undefined" ? undefined : sessionStorage);

/** Chat | Code: route navigation, so two links with `aria-current`, not a tablist. Makes no backend query. */
const WorkspaceSwitch: FC = () => {
    const { t } = useLingui();
    const enabled = useCodeModeEnabled();
    const router = useRouter();
    const { pathname } = useLocation();
    const active = workspaceOf(pathname);

    useEffect(() => {
        const sessionStore = store();

        if (sessionStore) {
            rememberWorkspaceRoute(sessionStore, pathname);
        }
    }, [pathname]);

    if (enabled !== true) {
        return null;
    }

    const items = [
        { icon: MessageSquareIcon, label: t`Chat`, mode: "chat" as const },
        { icon: Code2Icon, label: t`Code`, mode: "code" as const },
    ];

    return (
        <nav aria-label={t`Workspace`} className="bg-muted text-muted-foreground inline-flex h-8 items-center rounded-lg p-1">
            {items.map(({ icon: Icon, label, mode }) => {
                const isActive = active === mode;

                return (
                    <Link
                        aria-current={isActive ? "page" : undefined}
                        className={cn(ITEM, isActive ? "bg-background text-foreground shadow-sm" : "hover:text-foreground")}
                        key={mode}
                        // Server and first client render both link to the root; the remembered page is read on click.
                        onClick={(event) => {
                            const target = workspaceTarget(store(), mode);

                            if (
                                target === ROOT_LINKS[mode] ||
                                event.defaultPrevented ||
                                event.button !== 0 ||
                                event.metaKey ||
                                event.ctrlKey ||
                                event.shiftKey ||
                                event.altKey
                            ) {
                                return;
                            }

                            event.preventDefault();
                            router.history.push(target);
                        }}
                        to={ROOT_LINKS[mode]}
                    >
                        <Icon aria-hidden="true" className="size-3.5" />
                        {label}
                    </Link>
                );
            })}
        </nav>
    );
};

export default WorkspaceSwitch;
