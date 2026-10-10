"use client";

import { trackEvent } from "@/lib/analytics";

import useLastSignInMethod from "./use-last-signin-method";

const useSocialSignInTracking = () => {
    const { saveLastSignIn } = useLastSignInMethod();

    const trackSocialSignIn = (provider: string, email?: string) => {
        saveLastSignIn("social", email, provider);
        trackEvent("signed_in", { provider });
    };

    return {
        trackSocialSignIn,
    };
};

export default useSocialSignInTracking;
