import { useEffect } from "react";

import { useAuth } from "@/features/auth/lib/auth-ui-provider";
import type { AuthClient } from "@/lib/auth/client";

import type { AuthView } from "../lib/auth-view-paths";
import { useSession } from "./session-user-management";

interface AuthenticateOptions<TAuthClient extends AuthClient> {
    authClient?: TAuthClient;
    authView?: AuthView;
    enabled?: boolean;
}

const useAuthenticate = <TAuthClient extends AuthClient>(options?: AuthenticateOptions<TAuthClient>) => {
    type Session = TAuthClient["$Infer"]["Session"]["session"];
    type User = TAuthClient["$Infer"]["Session"]["user"];

    const { authView = "SIGN_IN", enabled = true } = options ?? {};

    const { authClient, basePath, replace, viewPaths } = useAuth();

    const { data, error, isPending, refetch } = useSession(authClient);
    const sessionData = data as
        | {
              session: Session;
              user: User;
          }
        | null
        | undefined;

    useEffect(() => {
        if (!enabled || isPending || sessionData) {
            return;
        }

        replace(`${basePath}/${viewPaths[authView]}?redirectTo=${globalThis.location.href.replace(globalThis.location.origin, "")}`);
    }, [isPending, sessionData, basePath, viewPaths, replace, authView, enabled]);

    return {
        data: sessionData,
        error,
        isPending,
        refetch,
        user: sessionData?.user,
    };
};

export default useAuthenticate;
