"use client";

import { useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { useNavigate } from "@tanstack/react-router";
import { Cable, X } from "lucide-react";
import { useCallback, useEffect, useId, useState } from "react";

import { requestMcpInstall } from "@/features/settings/components/chat/mcp/pending-install";

import { isConnectorActionable } from "../lib/skill-builder";
import { ConnectorStatusBadge, useRecommendedConnectorStatuses } from "./skill-builder-connector-status";
import type { SkillBuilderSaved } from "./skill-builder-dialog";
import { CONNECTOR_LABELS } from "./skill-builder-dialog";

const STORAGE_KEY = "neore:skill-builder-setup";

/**
 * The post-save setup list, kept in sessionStorage: each step navigates to a
 * settings page, which unmounts the skills list, and the remaining steps must
 * still be there when the user comes back.
 */
export const useBuilderSetupState = (): [SkillBuilderSaved | null, (next: SkillBuilderSaved | null) => void] => {
    const [state, setState] = useState<SkillBuilderSaved | null>(null);

    // Read after mount, not in the initializer: SSR has no sessionStorage, and
    // differing first renders would be a hydration mismatch.
    useEffect(() => {
        try {
            const raw = globalThis.sessionStorage?.getItem(STORAGE_KEY);

            if (raw) {
                setState(JSON.parse(raw) as SkillBuilderSaved);
            }
        } catch {
            // Unreadable or unavailable storage: start empty.
        }
    }, []);

    const update = useCallback((next: SkillBuilderSaved | null) => {
        const isEmpty = !next || (next.mcpServers.length === 0 && next.connectors.length === 0);

        setState(isEmpty ? null : next);

        try {
            if (isEmpty) {
                globalThis.sessionStorage?.removeItem(STORAGE_KEY);
            } else {
                globalThis.sessionStorage?.setItem(STORAGE_KEY, JSON.stringify(next));
            }
        } catch {
            // Storage unavailable (private mode): the list simply does not survive navigation.
        }
    }, []);

    return [state, update];
};

interface SkillBuilderSetupProps {
    onDismiss: () => void;
    onDone: (next: SkillBuilderSaved) => void;
    pending: SkillBuilderSaved;
}

/**
 * After an Agent Builder save: the integrations the user accepted, each one a
 * step they take themselves. An MCP server opens the ordinary add-server form,
 * prefilled — it is added only when they save it there.
 */
const SkillBuilderSetup = ({ onDismiss, onDone, pending }: SkillBuilderSetupProps) => {
    const { t } = useLingui();
    const id = useId();
    const navigate = useNavigate();
    const connectorStatus = useRecommendedConnectorStatuses(pending.connectors.map((connector) => connector.id));

    if (pending.mcpServers.length === 0 && pending.connectors.length === 0) {
        return null;
    }

    const openSettings = (to: "/dashboard/settings/chat/mcp" | "/dashboard/settings/connectors") => {
        navigate({ to }).catch(() => undefined);
    };

    return (
        <section aria-labelledby={id} className="bg-muted/40 space-y-3 rounded-lg border p-4">
            <div className="flex items-start justify-between gap-2">
                <div className="space-y-1">
                    <h2 className="flex items-center gap-2 text-sm font-medium" id={id}>
                        <Cable aria-hidden="true" className="size-4" />
                        {t`Finish setting up "${pending.name}"`}
                    </h2>
                    <p className="text-muted-foreground text-xs">{t`You chose these integrations in the agent builder. Each one opens for you to review before anything connects.`}</p>
                </div>
                <Button aria-label={t`Dismiss setup suggestions`} onClick={onDismiss} size="icon" type="button" variant="ghost">
                    <X aria-hidden="true" className="size-4" />
                </Button>
            </div>
            <ul className="space-y-2">
                {pending.mcpServers.map(({ reason, server }) => (
                    <li className="flex items-center justify-between gap-3" key={server.id}>
                        <span className="grid gap-0.5 text-sm">
                            <span className="font-medium">{t`MCP server: ${server.title}`}</span>
                            <span className="text-muted-foreground text-xs">{reason}</span>
                        </span>
                        <Button
                            onClick={() => {
                                requestMcpInstall(server);
                                onDone({ ...pending, mcpServers: pending.mcpServers.filter((item) => item.server.id !== server.id) });
                                openSettings("/dashboard/settings/chat/mcp");
                            }}
                            size="sm"
                            type="button"
                            variant="outline"
                        >
                            {t`Review and add`}
                        </Button>
                    </li>
                ))}
                {pending.connectors.map((connector) => (
                    <li className="flex items-center justify-between gap-3" key={connector.id}>
                        <span className="grid gap-0.5 text-sm">
                            <span className="font-medium">{t`Connector: ${CONNECTOR_LABELS[connector.id] ?? connector.id}`}</span>
                            <span className="text-muted-foreground text-xs">{connector.reason}</span>
                            <ConnectorStatusBadge status={connectorStatus?.[connector.id]} />
                        </span>
                        {isConnectorActionable(connectorStatus?.[connector.id]) && (
                            <Button
                                onClick={() => {
                                    onDone({ ...pending, connectors: pending.connectors.filter((item) => item.id !== connector.id) });
                                    openSettings("/dashboard/settings/connectors");
                                }}
                                size="sm"
                                type="button"
                                variant="outline"
                            >
                                {connectorStatus?.[connector.id] === "expired" ? t`Reconnect` : t`Connect`}
                            </Button>
                        )}
                    </li>
                ))}
            </ul>
        </section>
    );
};

export default SkillBuilderSetup;
