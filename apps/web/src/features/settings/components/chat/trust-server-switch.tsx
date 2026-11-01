import { useLingui } from "@lingui/react/macro";
import { connectorTrustId, mcpTrustId } from "@neore/backend/chat/low-risk-trust";
import { Label } from "@neore/ui/components/label";
import { Switch } from "@neore/ui/components/switch";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { FC } from "react";
import { useId } from "react";

import { useCRPC } from "@/lib/lunora/crpc";
import { showError } from "@/lib/toast";

export type TrustableServer = { kind: "connector"; name: string; slug: string } | { kind: "mcp"; name: string; url: string };

/**
 * The switch that lets the quick check judge this server's tools (`chat/lib/low-risk-trust.ts`). Shown only
 * while the quick check is on. A server's tool descriptions reach the model, so a trusted server can influence which
 * calls are approved automatically, and the page says so.
 */
export const TrustServerSwitch: FC<{ server: TrustableServer }> = ({ server }) => {
    const { t } = useLingui();
    const crpc = useCRPC();
    const queryClient = useQueryClient();
    const switchId = useId();
    const detailsId = useId();
    const settingsOptions = crpc.chat.tool_permissions.getToolPermissionSettings.queryOptions({});
    const { data: settings } = useQuery(settingsOptions);
    const { isPending, mutate } = useMutation(crpc.chat.tool_permissions.setLowRiskTrustedServer.mutationOptions());

    if (settings?.autoApproveLowRisk !== true) {
        return null;
    }

    const id = server.kind === "mcp" ? mcpTrustId(server.name, server.url) : connectorTrustId(server.slug);
    const trusted = settings.lowRiskTrustedServers.includes(id);

    const handleChange = (next: boolean) => {
        mutate(
            { server: server.kind === "mcp" ? { kind: "mcp", name: server.name, url: server.url } : { kind: "connector", slug: server.slug }, trusted: next },
            {
                onError: (error) => showError(error instanceof Error ? error : t`Failed to update the trusted servers`),
                onSettled: () => {
                    void queryClient.invalidateQueries({ queryKey: settingsOptions.queryKey });
                },
            },
        );
    };

    return (
        <div className="mt-2 flex items-start justify-between gap-4 border-t pt-2">
            <div className="space-y-0.5">
                <Label htmlFor={switchId}>{t`Trust for auto-approval`}</Label>
                <p className="text-muted-foreground text-xs" id={detailsId}>
                    {t`The quick check only looks at tools from servers you trust. A trusted server's tool descriptions reach the model, so they can influence which calls are approved automatically. Changing a server's address ends its trust.`}
                </p>
            </div>
            <Switch aria-describedby={detailsId} checked={trusted} disabled={isPending} id={switchId} onCheckedChange={handleChange} />
        </div>
    );
};
