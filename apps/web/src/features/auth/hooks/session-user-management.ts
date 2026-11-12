import useIsHydrated from "@neore/ui/hooks/use-hydrated";
import type { AnyUseQueryOptions } from "@tanstack/react-query";
import { useQuery } from "@tanstack/react-query";
import { use, useMemo } from "react";

import type { AuthClient } from "@/lib/auth/client";

import type { AuthQueryOptions } from "../lib/auth-query-provider";
import { AuthQueryContext } from "../lib/auth-query-provider";
import type { AnyAuthClient } from "../types/auth-core-types";
import useAuthMutation from "./shared/use-auth-mutation";

// Session Management Hook
export const useSession = <TAuthClient extends AnyAuthClient>(authClient: TAuthClient, options?: Partial<AnyUseQueryOptions>) => {
    type SessionData = TAuthClient["$Infer"]["Session"];
    type User = TAuthClient["$Infer"]["Session"]["user"];
    type Session = TAuthClient["$Infer"]["Session"]["session"];

    const { queryOptions, sessionKey: queryKey, sessionQueryOptions } = use(AuthQueryContext);
    const mergedOptions = { ...queryOptions, ...sessionQueryOptions, ...options };

    const result = useQuery<SessionData>({
        queryFn: () => (authClient as AuthClient).getSession({ fetchOptions: { throw: true } }),
        queryKey,
        ...mergedOptions,
    });

    const rawSession = result.data?.session as Session | undefined;
    const rawUser = result.data?.user as User | undefined;

    // Revive the date strings into a COPY. `result.data` is the object React Query
    // holds in its cache and hands to every other subscriber, so writing the dates
    // back into it mutates shared state during render. Memoised on the raw value so
    // the identity stays stable between renders and callers can put it in deps.
    //
    // `data` below is re-wrapped with the same copies, because callers read the
    // dates off `useSession().data.session` as well as off `session` — and the
    // cache is seeded from two places (this query and `prefetchSession`), so the
    // reviving has to happen on read.
    const user = useMemo(
        () => (rawUser ? { ...rawUser, createdAt: new Date(rawUser.createdAt), updatedAt: new Date(rawUser.updatedAt) } : undefined),
        [rawUser],
    );

    const session = useMemo(
        () =>
            rawSession
                ? {
                      ...rawSession,
                      createdAt: new Date(rawSession.createdAt),
                      expiresAt: new Date(rawSession.expiresAt),
                      updatedAt: new Date(rawSession.updatedAt),
                  }
                : undefined,
        [rawSession],
    );

    const data = useMemo(() => (result.data ? ({ ...result.data, session, user } as SessionData) : result.data), [result.data, session, user]);
    // The server never has the session query, and a Suspense boundary hydrated after the query answered on the client
    // would draw the user where the server drew nothing (React #418). Read as pending until this component has hydrated,
    // on the server and in a hydration render alike; the render right after shows the real result.
    const isHydrated = useIsHydrated();

    if (!isHydrated) {
        return { ...result, data: undefined, isPending: true, isSuccess: false, session: undefined, status: "pending" as const, user: undefined };
    }

    return {
        ...result,
        data,
        session,
        user,
    };
};

// User Update Hook
export const useUpdateUser = <TAuthClient extends AnyAuthClient>(authClient: TAuthClient, options?: Partial<AuthQueryOptions>) => {
    type SessionData = TAuthClient["$Infer"]["Session"];

    const { sessionKey: queryKey } = use(AuthQueryContext);

    return useAuthMutation({
        mutationFn: authClient.updateUser,
        optimisticData: (parameters, previousSession: unknown) => {
            const session = previousSession as SessionData;

            return {
                ...session,
                user: { ...session.user, ...parameters },
            };
        },
        options,
        queryKey,
    });
};
