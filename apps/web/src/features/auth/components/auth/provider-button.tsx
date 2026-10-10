import { useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import cn from "@neore/ui/utils/cn";
import { useSearch } from "@tanstack/react-router";
import type { SocialProvider } from "better-auth/social-providers";
import { useCallback } from "react";

import useSocialSignInTracking from "@/features/auth/hooks/use-social-signin-tracking";
import { useAuth } from "@/features/auth/lib/auth-ui-provider";

import type { Provider } from "../../lib/social-providers";
import { getLocalizedError } from "../../lib/utilities";
import type { AuthCardClassNames } from "./auth-card";

interface ProviderButtonProperties {
    callbackURL?: string;
    className?: string;
    classNames?: AuthCardClassNames;
    isSubmitting: boolean;
    other?: boolean;
    provider: Provider;
    redirectTo?: string;
    setIsSubmitting: (isSubmitting: boolean) => void;
    socialLayout: "auto" | "horizontal" | "grid" | "vertical";
}

const ProviderButton = ({
    callbackURL: callbackURLProperty,
    className,
    classNames,
    isSubmitting,
    other,
    provider,
    redirectTo: redirectToProperty,
    setIsSubmitting,
    socialLayout,
}: ProviderButtonProperties) => {
    const { t } = useLingui();
    const { authClient, basePath, baseURL, genericOAuth, persistClient, redirectTo: contextRedirectTo, social, toast, viewPaths } = useAuth();
    const { trackSocialSignIn } = useSocialSignInTracking();

    const search = useSearch({ strict: false });

    const getRedirectTo = useCallback(
        () => redirectToProperty || search.redirectTo || contextRedirectTo,
        [redirectToProperty, search.redirectTo, contextRedirectTo],
    );

    const getCallbackURL = useCallback(
        () => `${baseURL}${callbackURLProperty || (persistClient ? `${basePath}/${viewPaths.CALLBACK}?redirectTo=${getRedirectTo()}` : getRedirectTo())}`,
        [callbackURLProperty, persistClient, basePath, viewPaths, baseURL, getRedirectTo],
    );

    const doSignInSocial = async () => {
        setIsSubmitting(true);

        try {
            if (other) {
                const oauth2Parameters = {
                    callbackURL: getCallbackURL(),
                    fetchOptions: { throw: true },
                    providerId: provider.provider,
                };

                if (genericOAuth?.signIn) {
                    await genericOAuth.signIn(oauth2Parameters);

                    // Track social sign-in
                    trackSocialSignIn(provider.provider);

                    setTimeout(() => {
                        setIsSubmitting(false);
                    }, 10_000);
                } else {
                    await (authClient as unknown as { signIn: { oauth2: (p: typeof oauth2Parameters) => Promise<unknown> } }).signIn.oauth2(oauth2Parameters);

                    // Track social sign-in
                    trackSocialSignIn(provider.provider);
                }
            } else {
                const socialParameters = {
                    callbackURL: getCallbackURL(),
                    fetchOptions: { throw: true },
                    provider: provider.provider as SocialProvider,
                };

                if (social?.signIn) {
                    await social.signIn(socialParameters);

                    // Track social sign-in
                    trackSocialSignIn(provider.provider);

                    setTimeout(() => {
                        setIsSubmitting(false);
                    }, 10_000);
                } else {
                    await authClient.signIn.social(socialParameters);

                    // Track social sign-in
                    trackSocialSignIn(provider.provider);
                }
            }
        } catch (error) {
            toast({
                message: getLocalizedError({ error, t }),
                variant: "error",
            });

            setIsSubmitting(false);
        }
    };

    return (
        <Button
            // The horizontal layout renders the icon alone, so the name must come from here.
            aria-label={t`Sign in with ${provider.name}`}
            className={cn(
                socialLayout === "vertical" ? "w-full" : "grow",
                className,
                classNames?.form?.button,
                classNames?.form?.outlineButton,
                classNames?.form?.providerButton,
            )}
            disabled={isSubmitting}
            onClick={doSignInSocial}
            variant="outline"
        >
            {provider.icon && <provider.icon className={classNames?.form?.icon} />}

            {socialLayout === "grid" && provider.name}
            {socialLayout === "vertical" && t`Sign in with ${provider.name}`}
        </Button>
    );
};

export default ProviderButton;
