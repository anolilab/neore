"use client";

import { useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { useAppForm } from "@neore/ui/components/form";
import { Input } from "@neore/ui/components/input";
import useIsHydrated from "@neore/ui/hooks/use-hydrated";
import cn from "@neore/ui/utils/cn";
import { useStore } from "@tanstack/react-form";
import { useSearch } from "@tanstack/react-router";
import type { BetterFetchOption } from "better-auth/react";
import { Loader2 } from "lucide-react";
import { useEffect } from "react";
import * as z from "zod";

import useCaptcha from "@/features/auth/hooks/use-captcha";
import { useAuth } from "@/features/auth/lib/auth-ui-provider";
import { getLocalizedError } from "@/features/auth/lib/utilities";
import emailSchema from "@/features/auth/validators/email-schema";

import Captcha from "../../captcha/captcha";
import type { AuthFormClassNames } from "../auth-form";

export interface MagicLinkFormProperties {
    callbackURL?: string;
    className?: string;
    classNames?: AuthFormClassNames;
    isSubmitting?: boolean;
    redirectTo?: string;
    setIsSubmitting?: (value: boolean) => void;
}

const MagicLinkForm = ({
    callbackURL: callbackURLProperty,
    className,
    classNames,
    isSubmitting,
    redirectTo: redirectToProperty,
    setIsSubmitting,
}: MagicLinkFormProperties) => {
    const { t } = useLingui();
    const isHydrated = useIsHydrated();
    const { captchaRef, getCaptchaHeaders } = useCaptcha();

    const { authClient, basePath, baseURL, persistClient, redirectTo: contextRedirectTo, toast, viewPaths } = useAuth();

    const search = useSearch({ strict: false });

    const getRedirectTo = () => redirectToProperty || search.redirectTo || contextRedirectTo;

    const getCallbackURL = () =>
        `${baseURL}${callbackURLProperty || (persistClient ? `${basePath}/${viewPaths.CALLBACK}?redirectTo=${getRedirectTo()}` : getRedirectTo())}`;

    const formSchema = z.strictObject({
        email: emailSchema,
    });

    const form = useAppForm({
        defaultValues: {
            email: "",
        },
        onSubmit: async ({ value }: { value: { email: string } }) => {
            try {
                const fetchOptions: BetterFetchOption = {
                    headers: await getCaptchaHeaders("/sign-in/magic-link"),
                    throw: true,
                };

                await authClient.signIn.magicLink({
                    callbackURL: getCallbackURL(),
                    email: value.email,
                    fetchOptions,
                });

                toast({
                    message: t`Magic link email sent`,
                    variant: "success",
                });

                form.reset();
            } catch (error) {
                toast({
                    message: getLocalizedError({ error, t }),
                    variant: "error",
                });
            }
        },
        validators: {
            onChange: ({ value }: { value: { email: string } }) => {
                const result = formSchema.safeParse(value);

                if (!result.success) {
                    return result.error.flatten().fieldErrors;
                }

                return undefined;
            },
        },
    });

    const isFormSubmitting = useStore(form.store, (state) => state.isSubmitting);

    useEffect(() => {
        setIsSubmitting?.(isFormSubmitting);
    }, [isFormSubmitting, setIsSubmitting]);

    return (
        <form.AppForm>
            <form
                className={cn("grid w-full gap-6", className, classNames?.base)}
                noValidate={isHydrated}
                onSubmit={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    form.handleSubmit();
                }}
                suppressHydrationWarning
            >
                <form.AppField name="email">
                    {(field) => (
                        <field.FormItem>
                            <field.FormLabel className={classNames?.label}>{t`Email`}</field.FormLabel>

                            <field.FormControl>
                                <Input
                                    autoComplete="email"
                                    className={classNames?.input}
                                    disabled={isSubmitting}
                                    onBlur={field.handleBlur}
                                    onChange={(e) => {
                                        field.handleChange(e.target.value);
                                    }}
                                    placeholder={t`Enter your email`}
                                    type="email"
                                    value={field.state.value}
                                />
                            </field.FormControl>

                            <field.FormMessage className={classNames?.error} />
                        </field.FormItem>
                    )}
                </form.AppField>

                <Captcha action="/sign-in/magic-link" ref={captchaRef} />

                <form.Subscribe selector={(state) => ({ canSubmit: state.canSubmit, isSubmitting: state.isSubmitting }) as unknown as typeof state}>
                    {({ canSubmit, isSubmitting: isSubmittingState }) => (
                        <Button className={cn("w-full", classNames?.button, classNames?.primaryButton)} disabled={!canSubmit || isSubmitting} type="submit">
                            {isSubmittingState || isSubmitting ? <Loader2 className="animate-spin" /> : t`Send Magic Link`}
                        </Button>
                    )}
                </form.Subscribe>
            </form>
        </form.AppForm>
    );
};

export default MagicLinkForm;
