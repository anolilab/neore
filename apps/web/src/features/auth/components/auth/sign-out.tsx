"use client";

import { Loader2 } from "lucide-react";
import { useEffect, useRef } from "react";

import { useAuth } from "@/features/auth/lib/auth-ui-provider";
import { useReleasePushOnSignOut } from "@/features/notifications/hooks/use-release-push-on-sign-out";
import { trackEvent } from "@/lib/analytics";

const SignOut = () => {
    const signingOut = useRef(false);

    const { authClient, basePath, viewPaths } = useAuth();
    const releasePush = useReleasePushOnSignOut();

    useEffect(() => {
        if (signingOut.current) {
            return;
        }

        signingOut.current = true;

        trackEvent("signed_out", {});

        // A full load of sign-in, not a reload: reloading `/auth/sign-out` would
        // mount this view again and sign out in a loop. A full load (rather than
        // a router navigation) also drops every client cache of the old session.
        const signInPath = `${basePath}/${viewPaths.SIGN_IN}`;

        // An error leaves too: after account deletion the server may already
        // have dropped the session, and a spinner forever helps nobody.
        // Push first, while the session still authenticates the server call.
        void releasePush().then(() =>
            authClient.signOut({
                fetchOptions: {
                    onError: () => {
                        globalThis.location.replace(signInPath);
                    },
                    onSuccess: () => {
                        globalThis.location.replace(signInPath);
                    },
                },
            }),
        );
    }, [authClient, basePath, releasePush, viewPaths]);

    return <Loader2 className="animate-spin" />;
};

export default SignOut;
