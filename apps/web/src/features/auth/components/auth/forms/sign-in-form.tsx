"use client";

import { useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { Checkbox } from "@neore/ui/components/checkbox";
import { useAppForm } from "@neore/ui/components/form";
import PasswordInput from "@neore/ui/components/form/password-input";
import { Input } from "@neore/ui/components/input";
import useIsHydrated from "@neore/ui/hooks/use-hydrated";
import cn from "@neore/ui/utils/cn";
import { useStore } from "@tanstack/react-form";
import { Link } from "@tanstack/react-router";
import type { BetterFetchOption } from "better-auth/react";
import { Loader2 } from "lucide-react";
import { useEffect } from "react";
import * as z from "zod";

import useCaptcha from "@/features/auth/hooks/use-captcha";
import useLastSignInMethod from "@/features/auth/hooks/use-last-signin-method";
import useOnSuccessTransition from "@/features/auth/hooks/use-success-transition";
import { useAuth } from "@/features/auth/lib/auth-ui-provider";
import { getLocalizedError, isValidEmail } from "@/features/auth/lib/utilities";
import type { AuthClientWithUsernamePlugin } from "@/features/auth/types/auth-core-types";
import type { PasswordValidation } from "@/features/auth/types/form-validation-types";
import emailSchema from "@/features/auth/validators/email-schema";
import { trackEvent } from "@/lib/analytics";

import Captcha from "../../captcha/captcha";
import type { AuthFormClassNames } from "../auth-form";

export interface SignInFormProperties {
    className?: string;
    classNames?: AuthFormClassNames;
    isSubmitting?: boolean;
    passwordValidation?: PasswordValidation;
    redirectTo?: string;
    setIsSubmitting?: (isSubmitting: boolean) => void;
}

const SignInForm = ({ className, classNames, isSubmitting, passwordValidation, redirectTo, setIsSubmitting }: SignInFormProperties): React.JSX.Element => {
    const { t } = useLingui();
    const isHydrated = useIsHydrated();
    const { captchaRef, getCaptchaHeaders } = useCaptcha();
    const { lastSignIn, saveLastSignIn } = useLastSignInMethod();

    const { authClient, basePath, credentials, navigate, toast, viewPaths } = useAuth();

    const rememberMeEnabled = credentials?.rememberMe;
    const usernameEnabled = credentials?.username;
    const contextPasswordValidation = credentials?.passwordValidation;

    const finalPasswordValidation = { ...contextPasswordValidation, ...passwordValidation };

    const getPreferredInputType = (): "username" | "email" => {
        if (!lastSignIn || lastSignIn.method === "anonymous") {
            return usernameEnabled ? "username" : "email";
        }

        if (lastSignIn.method === "username") {
            return "username";
        }

        return "email";
    };

    const preferredInputType = getPreferredInputType();
    const shouldShowUsernameFirst = preferredInputType === "username";

    const getInputLabel = (): string => {
        if (shouldShowUsernameFirst) {
            return t`Username`;
        }

        if (usernameEnabled) {
            return t`Email or Username`;
        }

        return t`Email`;
    };

    const getInputPlaceholder = (): string => {
        if (shouldShowUsernameFirst) {
            return t`Enter your username`;
        }

        if (usernameEnabled) {
            return t`Enter your email or username`;
        }

        return t`Enter your email`;
    };

    const { isPending: transitionPending, onSuccess } = useOnSuccessTransition({
        redirectTo,
    });

    // Helper function to get email validation schema
    const getEmailSchema = () => {
        if (shouldShowUsernameFirst) {
            return z.string().min(1, {
                message: t`Username is required`,
            });
        }

        if (usernameEnabled) {
            return z.union([
                emailSchema,
                z.string().min(1, {
                    message: t`Username or email is required`,
                }),
            ]);
        }

        return emailSchema;
    };

    const formSchema = z.strictObject({
        email: getEmailSchema(),
        password: (() => {
            let schema = z.string().min(1, {
                message: t`Password is required`,
            });

            if (finalPasswordValidation?.minLength) {
                schema = schema.min(finalPasswordValidation.minLength, {
                    message: t`Password is too short`,
                });
            }

            if (finalPasswordValidation?.maxLength) {
                schema = schema.max(finalPasswordValidation.maxLength, {
                    message: t`Password is too long`,
                });
            }

            if (finalPasswordValidation?.regex) {
                schema = schema.regex(finalPasswordValidation.regex, {
                    message: t`Invalid password`,
                });
            }

            return schema;
        })(),
        rememberMe: z.boolean(),
    });

    const form = useAppForm({
        defaultValues: {
            // Static on purpose: TanStack Form re-applies changed `defaultValues` to
            // an untouched form, and `lastSignIn` arrives from localStorage AFTER
            // hydration — so deriving the email here wiped a password typed (or
            // autofilled by a password manager) in that window. Prefilled below.
            email: "",
            password: "",
            rememberMe: !rememberMeEnabled,
        },
        onSubmit: async ({ value }) => {
            try {
                let response: Record<string, unknown> = {};

                // Determine sign-in method based on input type and value
                const shouldUseUsername = usernameEnabled && (shouldShowUsernameFirst || !isValidEmail(value.email));

                if (shouldUseUsername) {
                    const fetchOptions: BetterFetchOption = {
                        headers: await getCaptchaHeaders("/sign-in/username"),
                        throw: true,
                    };

                    response = await (authClient as unknown as AuthClientWithUsernamePlugin).signIn.username({
                        fetchOptions,
                        password: value.password,
                        rememberMe: value.rememberMe,
                        username: value.email,
                    });

                    // Save last sign-in method
                    saveLastSignIn("username", value.email);
                    trackEvent("signed_in", { provider: "username" });
                } else {
                    const fetchOptions: BetterFetchOption = {
                        headers: await getCaptchaHeaders("/sign-in/email"),
                        throw: true,
                    };

                    response = await authClient.signIn.email({
                        email: value.email,
                        fetchOptions,
                        password: value.password,
                        rememberMe: value.rememberMe,
                    });

                    // Save last sign-in method
                    saveLastSignIn("email", value.email);
                    trackEvent("signed_in", { provider: "email" });
                }

                if (response.twoFactorRedirect) {
                    navigate(`${basePath}/${viewPaths.TWO_FACTOR}${globalThis.location.search}`);
                } else {
                    await onSuccess();
                }
            } catch (error) {
                form.setFieldValue("password", "");

                toast({
                    message: getLocalizedError({ error, t }),
                    variant: "error",
                });
            }
        },
        validators: {
            onChange: formSchema,
        },
    });

    const isFormSubmitting = useStore(form.store, (state) => state.isSubmitting);

    // The remembered email, once it is read — only into an empty field.
    const rememberedEmail = lastSignIn?.method === "anonymous" ? undefined : lastSignIn?.email;

    useEffect(() => {
        if (rememberedEmail && form.getFieldValue("email") === "") {
            form.setFieldValue("email", rememberedEmail, { dontUpdateMeta: true });
        }
    }, [form, rememberedEmail]);

    useEffect(() => {
        setIsSubmitting?.(Boolean(isFormSubmitting || transitionPending));
    }, [isFormSubmitting, transitionPending, setIsSubmitting]);

    return (
        <form.AppForm>
            <form
                className={cn("grid w-full gap-6", className, classNames?.base)}
                noValidate={isHydrated}
                onSubmit={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    form.handleSubmit();
                }}
                suppressHydrationWarning
            >
                <form.AppField name="email">
                    {(field) => (
                        <field.FormItem>
                            <field.FormLabel className={classNames?.label}>{getInputLabel()}</field.FormLabel>

                            <field.FormControl>
                                <Input
                                    autoComplete={shouldShowUsernameFirst ? "username" : "email"}
                                    className={classNames?.input}
                                    disabled={isSubmitting}
                                    onBlur={field.handleBlur}
                                    onChange={(event) => field.handleChange(event.target.value)}
                                    placeholder={getInputPlaceholder()}
                                    type={shouldShowUsernameFirst ? "text" : "email"}
                                    value={field.state.value}
                                />
                            </field.FormControl>

                            <field.FormMessage className={classNames?.error} />
                        </field.FormItem>
                    )}
                </form.AppField>

                <form.AppField name="password">
                    {(field) => (
                        <field.FormItem>
                            <div className="flex items-center justify-between">
                                <field.FormLabel className={classNames?.label}>{t`Password`}</field.FormLabel>

                                {credentials?.forgotPassword && (
                                    <Link
                                        className={cn("text-sm hover:underline", classNames?.forgotPasswordLink)}
                                        to={`${basePath}/${viewPaths.FORGOT_PASSWORD}${isHydrated ? globalThis.location.search : ""}`}
                                    >
                                        {t`Forgot password?`}
                                    </Link>
                                )}
                            </div>

                            <field.FormControl>
                                <PasswordInput
                                    autoComplete="current-password"
                                    className={classNames?.input}
                                    disabled={isSubmitting}
                                    onBlur={field.handleBlur}
                                    onChange={(event) => field.handleChange(event.target.value)}
                                    placeholder={t`Enter your password`}
                                    value={field.state.value}
                                />
                            </field.FormControl>

                            <field.FormMessage className={classNames?.error} />
                        </field.FormItem>
                    )}
                </form.AppField>

                {rememberMeEnabled && (
                    <form.AppField name="rememberMe">
                        {(field) => (
                            <field.FormItem className="flex">
                                <field.FormControl>
                                    <Checkbox
                                        checked={field.state.value}
                                        disabled={isSubmitting}
                                        onCheckedChange={(checked) => field.handleChange(checked === true)}
                                    />
                                </field.FormControl>

                                <field.FormLabel>{t`Remember me`}</field.FormLabel>
                            </field.FormItem>
                        )}
                    </form.AppField>
                )}

                <Captcha action="/sign-in/email" ref={captchaRef} />

                <form.Subscribe selector={(state) => ({ canSubmit: state.canSubmit, isSubmitting: state.isSubmitting }) as unknown as typeof state}>
                    {({ canSubmit, isSubmitting: isSubmittingState }) => (
                        <Button className={cn("w-full", classNames?.button, classNames?.primaryButton)} disabled={!canSubmit || isSubmitting} type="submit">
                            {isSubmittingState || isSubmitting ? <Loader2 className="animate-spin" /> : t`Sign in`}
                        </Button>
                    )}
                </form.Subscribe>
            </form>
        </form.AppForm>
    );
};

export default SignInForm;
