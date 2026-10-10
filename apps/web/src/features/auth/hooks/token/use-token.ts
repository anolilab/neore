import type { AnyUseQueryOptions } from "@tanstack/react-query";
import { use, useCallback, useEffect, useEffectEvent, useMemo } from "react";

import { AuthQueryContext } from "../../lib/auth-query-provider";
import type { AnyAuthClient } from "../../types/auth-core-types";
import { useSession } from "../session-user-management";
import useAuthQuery from "../shared/use-auth-query";

export const decodeJwt = (token: string) => {
    const decode = (data: string) => {
        if (typeof Buffer === "undefined") {
            return atob(data);
        }

        return Buffer.from(data, "base64").toString();
    };
    const parts = token.split(".").map((part) => decode(part.replaceAll("-", "+").replaceAll("_", "/")));

    return JSON.parse(parts[1]!);
};

export const useToken = <TAuthClient extends AnyAuthClient>(authClient: TAuthClient, options?: Partial<AnyUseQueryOptions>) => {
    const { data: sessionData } = useSession(authClient, options);
    const { queryOptions, tokenKey, tokenQueryOptions } = use(AuthQueryContext);
    const mergedOptions = { ...queryOptions, ...tokenQueryOptions, ...options };

    const queryResult = useAuthQuery<{ token: string }>({
        authClient,
        options: {
            enabled: !!sessionData && (mergedOptions.enabled ?? true),
            // Don't refetch on window focus - handled by CRPCProvider
            refetchOnWindowFocus: false,
            // Don't retry on error - Better Auth handles token lifecycle via server functions
            // Token is managed server-side via getSessionToken() and CRPCProvider
            retry: false,
        },
        queryFn: ({ fetchOptions }) => authClient.$fetch("/token", fetchOptions),
        queryKey: tokenKey,
    });

    const { data, refetch, ...rest } = queryResult;
    const payload = useMemo(() => (data ? decodeJwt(data.token) : null), [data]);

    const onRefetch = useEffectEvent(() => {
        refetch();
    });

    useEffect(() => {
        if (!data?.token) {
            return undefined;
        }

        const decodedPayload = decodeJwt(data.token);

        if (!decodedPayload?.exp) {
            return undefined;
        }

        const expiresAt = decodedPayload.exp * 1000;
        const expiresIn = expiresAt - Date.now();

        const timeout = setTimeout(onRefetch, expiresIn);

        return () => {
            clearTimeout(timeout);
        };
    }, [data]);

    const isTokenExpired = useCallback(() => {
        if (!data?.token) {
            return true;
        }

        const decodedPayload = decodeJwt(data.token);

        if (!decodedPayload?.exp) {
            return true;
        }

        return decodedPayload.exp < Date.now() / 1000;
    }, [data]);

    useEffect(() => {
        if (!sessionData) {
            return;
        }

        if (payload?.sub !== sessionData.user.id) {
            onRefetch();
        }
    }, [payload, sessionData]);

    const tokenData = useMemo(
        () => (!sessionData || isTokenExpired() || sessionData?.user.id !== payload?.sub ? undefined : data),
        [sessionData, isTokenExpired, payload, data],
    );

    return { ...rest, data: tokenData, payload, refetch, token: tokenData?.token ?? "" };
};
