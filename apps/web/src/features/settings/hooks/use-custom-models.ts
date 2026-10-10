"use client";

import { useLingui } from "@lingui/react/macro";
import type { GatewayModel } from "@neore/ai/models";
import { skipToken, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import useIsAnonymous from "@/features/auth/hooks/use-is-anonymous";
import { toCustomGatewayModels } from "@/features/settings/lib/custom-models";
import { useCRPC } from "@/lib/lunora/crpc";

/**
 * Models from the user's own endpoints (Settings → API Keys → Custom
 * endpoints), shaped as picker entries with `custom:<providerId>/<modelId>` ids.
 * Pass `enabled: false` to skip the query entirely.
 */
const useCustomModels = (enabled = true): GatewayModel[] => {
    const { i18n } = useLingui();
    const crpc = useCRPC();
    const { isAnonymous } = useIsAnonymous();
    const { data } = useQuery(crpc.chat.custom_providers.listCustomProviders.queryOptions(enabled && !isAnonymous ? {} : skipToken));

    return useMemo(() => toCustomGatewayModels(data, i18n), [data, i18n]);
};

export default useCustomModels;
