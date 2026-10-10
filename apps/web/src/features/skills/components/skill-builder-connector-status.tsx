"use client";

import { useLingui } from "@lingui/react/macro";
import { Badge } from "@neore/ui/components/badge";
import { skipToken, useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { useCRPC } from "@/lib/lunora/crpc";

import type { ConnectorStatus } from "../lib/skill-builder";
import { connectorStatuses } from "../lib/skill-builder";

/**
 * Status of the recommended connectors, from the connectors catalogue. Called
 * only by builder surfaces that are mounted on demand, and skipped when there
 * is nothing to look up — the skills page itself never pays for this query.
 * While it loads, `statuses` is undefined and callers show no badge.
 */
export const useRecommendedConnectorStatuses = (slugs: ReadonlyArray<string>): Record<string, ConnectorStatus> | undefined => {
    const crpc = useCRPC();
    const { data } = useQuery(crpc.connectors.user_connectors.listConnectorCatalog.queryOptions(slugs.length > 0 ? {} : skipToken));
    const [now] = useState(Date.now);

    return data ? connectorStatuses(data, slugs, now) : undefined;
};

export const ConnectorStatusBadge = ({ status }: { status: ConnectorStatus | undefined }) => {
    const { t } = useLingui();

    if (!status) {
        return null;
    }

    const labels: Record<ConnectorStatus, string> = {
        available: t`Available`,
        connected: t`Connected`,
        expired: t`Expired — reconnect`,
        notConfigured: t`Not configured by the operator`,
    };

    return (
        <Badge className="w-fit" variant={status === "connected" ? "secondary" : "outline"}>
            {labels[status]}
        </Badge>
    );
};
