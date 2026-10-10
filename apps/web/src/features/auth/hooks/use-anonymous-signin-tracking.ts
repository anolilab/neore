"use client";

import useLastSignInMethod from "./use-last-signin-method";

export default function useAnonymousSignInTracking() {
    const { saveLastSignIn } = useLastSignInMethod();

    const trackAnonymousSignIn = () => {
        saveLastSignIn("anonymous");
    };

    return {
        trackAnonymousSignIn,
    };
}
