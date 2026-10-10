"use client";

import { useLingui } from "@lingui/react/macro";
import { Avatar, AvatarFallback, AvatarImage } from "@neore/ui/components/avatar";
import { Button } from "@neore/ui/components/button";
import { Checkbox } from "@neore/ui/components/checkbox";
import { useAppForm } from "@neore/ui/components/form";
import PasswordInput from "@neore/ui/components/form/password-input";
import { Input } from "@neore/ui/components/input";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@neore/ui/components/responsive-dropdown-menu";
import useIsHydrated from "@neore/ui/hooks/use-hydrated";
import cn from "@neore/ui/utils/cn";
import { useSearch } from "@tanstack/react-router";
import type { BetterFetchOption } from "better-auth/react";
import { Loader2, Trash2Icon, UploadCloudIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import * as z from "zod";

import useCaptcha from "@/features/auth/hooks/use-captcha";
import useOnSuccessTransition from "@/features/auth/hooks/use-success-transition";
import { useAuth } from "@/features/auth/lib/auth-ui-provider";
import { fileToBase64, resizeAndCropImage } from "@/features/auth/lib/image-utilities";
import { withInviteToken } from "@/features/auth/lib/invite-token";
import { getLocalizedError } from "@/features/auth/lib/utilities";
import type { PasswordValidation } from "@/features/auth/types/form-validation-types";
import emailSchema from "@/features/auth/validators/email-schema";
import { trackEvent } from "@/lib/analytics";

import Captcha from "../../captcha/captcha";
import type { AuthFormClassNames } from "../auth-form";

export interface SignUpFormProperties {
    callbackURL?: string;
    className?: string;
    classNames?: AuthFormClassNames;
    isSubmitting?: boolean;
    passwordValidation?: PasswordValidation;
    redirectTo?: string;
    setIsSubmitting?: (value: boolean) => void;
}

// Fields the sign-up call handles itself; everything else is an `additionalFields` entry.
const BUILT_IN_SIGN_UP_FIELDS = new Set(["confirmPassword", "email", "image", "name", "password", "username"]);

const SignUpForm = ({
    callbackURL,
    className,
    classNames,
    isSubmitting: isSubmittingProperty,
    passwordValidation: passwordValidationProperty,
    redirectTo,
    setIsSubmitting,
}: SignUpFormProperties) => {
    const { t } = useLingui();
    const isHydrated = useIsHydrated();
    const { captchaRef, getCaptchaHeaders } = useCaptcha();

    const {
        additionalFields,
        authClient,
        avatar,
        basePath,
        baseURL,
        credentials,
        emailVerification,
        nameRequired,
        navigate,
        persistClient,
        redirectTo: contextRedirectTo,
        signUp: signUpOptions,
        toast,
        viewPaths,
    } = useAuth();

    const search = useSearch({ strict: false });

    const confirmPasswordEnabled = credentials?.confirmPassword;
    const usernameEnabled = credentials?.username;
    const contextPasswordValidation = credentials?.passwordValidation;
    const signUpFields = signUpOptions?.fields;

    const passwordValidation = { ...contextPasswordValidation, ...passwordValidationProperty };

    // Avatar upload state
    const fileInputReference = useRef<HTMLInputElement>(null);
    const [avatarImage, setAvatarImage] = useState<string | null>(null);
    const [uploadingAvatar, setUploadingAvatar] = useState(false);

    const getRedirectTo = useCallback(() => redirectTo || search?.redirectTo || contextRedirectTo, [redirectTo, search?.redirectTo, contextRedirectTo]);

    const getCallbackURL = useCallback(
        () => `${baseURL}${callbackURL || (persistClient ? `${basePath}/${viewPaths.CALLBACK}?redirectTo=${getRedirectTo()}` : getRedirectTo())}`,
        [callbackURL, persistClient, basePath, viewPaths, baseURL, getRedirectTo],
    );

    const { isPending: transitionPending, onSuccess } = useOnSuccessTransition({
        redirectTo,
    });

    // Create the base schema for standard fields
    const schemaFields: Record<string, z.ZodTypeAny> = {
        email: emailSchema,
        password: (() => {
            let schema = z.string().min(1, {
                message: t`Password is required`,
            });

            if (passwordValidation?.minLength) {
                schema = schema.min(passwordValidation.minLength, {
                    message: t`Password is too short`,
                });
            }

            if (passwordValidation?.maxLength) {
                schema = schema.max(passwordValidation.maxLength, {
                    message: t`Password is too long`,
                });
            }

            if (passwordValidation?.regex) {
                schema = schema.regex(passwordValidation.regex, {
                    message: t`Invalid password`,
                });
            }

            return schema;
        })(),
    };

    // Add confirmPassword field if enabled
    if (confirmPasswordEnabled) {
        schemaFields.confirmPassword = (() => {
            let schema = z.string().min(1, {
                message: t`Confirm password is required`,
            });

            if (passwordValidation?.minLength) {
                schema = schema.min(passwordValidation.minLength, {
                    message: t`Password is too short`,
                });
            }

            if (passwordValidation?.maxLength) {
                schema = schema.max(passwordValidation.maxLength, {
                    message: t`Password is too long`,
                });
            }

            if (passwordValidation?.regex) {
                schema = schema.regex(passwordValidation.regex, {
                    message: t`Invalid password`,
                });
            }

            return schema;
        })();
    }

    // Add name field if required or included in signUpFields
    if (signUpFields?.includes("name")) {
        schemaFields.name = nameRequired
            ? z.string().min(1, {
                  message: t`Name is required`,
              })
            : z.string().optional();
    }

    // Add username field if enabled
    if (usernameEnabled) {
        schemaFields.username = z.string().min(1, {
            message: t`Username is required`,
        });
    }

    // Add image field if included in signUpFields
    if (signUpFields?.includes("image") && avatar) {
        schemaFields.image = z.string().optional();
    }

    // Add additional fields from signUpFields
    if (signUpFields) {
        for (const field of signUpFields) {
            if (field === "name") {
                continue; // Already handled above;
            }

            if (field === "image") {
                continue; // Already handled above;
            }

            const additionalField = additionalFields?.[field];

            if (!additionalField) {
                continue;
            }

            const fieldLabel = String(additionalField.label || "");
            let fieldSchema: z.ZodTypeAny;

            // Create the appropriate schema based on field type
            if (additionalField.type === "number") {
                fieldSchema = additionalField.required
                    ? z.preprocess(
                          (value) => (value ? Number(value) : undefined),
                          z.number({
                              error: t`${fieldLabel} is required`,
                          }),
                      )
                    : z.coerce
                          .number({
                              error: t`${fieldLabel} is invalid`,
                          })
                          .optional();
            } else if (additionalField.type === "boolean") {
                // `z.preprocess(Boolean, …)` rather than `z.coerce.boolean()`: same
                // `Boolean(input)` conversion, without the coercion footgun where
                // the string "false" reads as true.
                fieldSchema = additionalField.required
                    ? z.preprocess(Boolean, z.boolean()).refine((value) => value, {
                          error: t`${fieldLabel} is required`,
                      })
                    : z.preprocess(Boolean, z.boolean()).optional();
            } else {
                fieldSchema = additionalField.required
                    ? z.string().min(1, {
                          message: t`${fieldLabel} is required`,
                      })
                    : z.string().optional();
            }

            schemaFields[field] = fieldSchema;
        }
    }

    // Create the final schema
    const formSchema = z.object(schemaFields).refine((data) => !confirmPasswordEnabled || data.password === data.confirmPassword, {
        error: t`Passwords do not match`,
        path: ["confirmPassword"],
    });

    // Create default values
    const defaultValues: Record<string, any> = {
        email: "",
        password: "",
        ...(confirmPasswordEnabled && { confirmPassword: "" }),
        ...(signUpFields?.includes("name") && { name: "" }),
        ...(usernameEnabled && { username: "" }),
        ...(signUpFields?.includes("image") && avatar && { image: "" }),
    };

    // Add default values for additional fields
    if (signUpFields) {
        for (const field of signUpFields) {
            if (field === "name" || field === "image") {
                continue;
            }

            const additionalField = additionalFields?.[field];

            if (!additionalField) {
                continue;
            }

            defaultValues[field] = additionalField.type === "boolean" ? false : "";
        }
    }

    const form = useAppForm({
        defaultValues,
        onSubmit: async ({ value }) => {
            try {
                // Validate additional fields with custom validators if provided
                for (const [field, fieldValue] of Object.entries(value)) {
                    if (BUILT_IN_SIGN_UP_FIELDS.has(field)) {
                        continue;
                    }

                    const additionalField = additionalFields?.[field];

                    if (!additionalField?.validate) {
                        continue;
                    }

                    if (typeof fieldValue === "string" && !(await additionalField.validate(fieldValue))) {
                        const fieldLabel = String(additionalField.label || "");

                        toast({
                            message: t`${fieldLabel} is invalid`,
                            variant: "error",
                        });

                        return;
                    }
                }

                const fetchOptions: BetterFetchOption = {
                    headers: await getCaptchaHeaders("/sign-up/email"),
                    throw: true,
                };

                const { email, image, name, password, username, ...additionalFieldValues } = value;

                // Client-side-only field — never forwarded to the sign-up API.
                delete additionalFieldValues.confirmPassword;

                // Registration is invite-only; the token rides in on `?invite=`.
                const data = await authClient.signUp.email(
                    withInviteToken({
                        email,
                        name: name || "",
                        password,
                        ...(username !== undefined && { username }),
                        ...(image !== undefined && { image }),
                        ...additionalFieldValues,
                        callbackURL: getCallbackURL(),
                        fetchOptions,
                    }),
                );

                trackEvent("signed_up", { provider: "email" });

                if ("token" in data && data.token) {
                    await onSuccess();
                } else {
                    if (emailVerification) {
                        toast({
                            message: t`Email verification sent`,
                            variant: "success",
                        });
                    } else {
                        toast({
                            message: t`Sign up successful`,
                            variant: "success",
                        });
                    }

                    navigate(`${basePath}/${viewPaths.SIGN_IN}${globalThis.location.search}`);
                }
            } catch (error) {
                toast({
                    message: getLocalizedError({ error, t }),
                    variant: "error",
                });

                form.reset();
            }
        },
        validators: {
            onChange: formSchema,
        },
    });

    const isSubmitting = isSubmittingProperty || form.state.isSubmitting || transitionPending;

    useEffect(() => {
        setIsSubmitting?.(form.state.isSubmitting || transitionPending);
    }, [form.state.isSubmitting, transitionPending, setIsSubmitting]);

    const handleAvatarChange = async (file: File) => {
        if (!file) {
            return;
        }

        setUploadingAvatar(true);

        try {
            const resizedFile = await resizeAndCropImage(file, crypto.randomUUID(), 200, "webp");
            const base64 = await fileToBase64(resizedFile);

            setAvatarImage(base64);
            form.setFieldValue("image", base64);
        } catch {
            toast({
                message: t`Failed to upload avatar`,
                variant: "error",
            });
        } finally {
            setUploadingAvatar(false);
        }
    };

    const handleDeleteAvatar = () => {
        setAvatarImage(null);
        form.setFieldValue("image", "");
    };

    const openFileDialog = () => fileInputReference.current?.click();

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
                {signUpFields?.includes("image") && avatar && (
                    <>
                        <input
                            accept="image/*"
                            disabled={uploadingAvatar}
                            hidden
                            onChange={(e) => {
                                const file = e.target.files?.item(0);

                                if (file) {
                                    handleAvatarChange(file);
                                }

                                e.target.value = "";
                            }}
                            ref={fileInputReference}
                            type="file"
                        />

                        <form.AppField name="image">
                            {(_field) => (
                                <div aria-labelledby="signup-avatar-label" className="space-y-2" role="group">
                                    <span className={cn("text-sm font-medium", classNames?.label)} id="signup-avatar-label">{t`Avatar`}</span>

                                    <div className="flex items-center gap-4">
                                        <DropdownMenu>
                                            <DropdownMenuTrigger
                                                render={
                                                    <Button className="size-fit rounded-full" size="icon" type="button" variant="ghost">
                                                        <form.Subscribe
                                                            selector={(state) => {
                                                                return {
                                                                    email: state.values.email || "",
                                                                    name: state.values.name || "",
                                                                };
                                                            }}
                                                        >
                                                            {({ email, name }) => (
                                                                <Avatar className="size-16">
                                                                    {avatarImage && <AvatarImage alt={name || t`User`} src={avatarImage} />}
                                                                    <AvatarFallback className="rounded-lg" name={name || email || undefined}>
                                                                        {name?.charAt(0)?.toUpperCase() || "U"}
                                                                    </AvatarFallback>
                                                                </Avatar>
                                                            )}
                                                        </form.Subscribe>
                                                    </Button>
                                                }
                                            />

                                            <DropdownMenuContent
                                                align="start"
                                                onCloseAutoFocus={(e) => {
                                                    e.preventDefault();
                                                }}
                                            >
                                                <DropdownMenuItem disabled={uploadingAvatar} onClick={openFileDialog}>
                                                    <UploadCloudIcon />
                                                    {t`Upload Avatar`}
                                                </DropdownMenuItem>

                                                {avatarImage && (
                                                    <DropdownMenuItem disabled={uploadingAvatar} onClick={handleDeleteAvatar} variant="destructive">
                                                        <Trash2Icon />
                                                        {t`Delete Avatar`}
                                                    </DropdownMenuItem>
                                                )}
                                            </DropdownMenuContent>
                                        </DropdownMenu>

                                        <Button disabled={uploadingAvatar} onClick={openFileDialog} type="button" variant="outline">
                                            {uploadingAvatar && <Loader2 className="animate-spin" />}

                                            {t`Upload`}
                                        </Button>
                                    </div>
                                </div>
                            )}
                        </form.AppField>
                    </>
                )}

                {signUpFields?.includes("name") && (
                    <form.AppField name="name">
                        {(field) => (
                            <field.FormItem>
                                <field.FormLabel className={classNames?.label}>{t`Name`}</field.FormLabel>

                                <field.FormControl>
                                    <Input
                                        autoComplete="name"
                                        className={classNames?.input}
                                        disabled={isSubmitting}
                                        onBlur={field.handleBlur}
                                        onChange={(e) => {
                                            field.handleChange(e.target.value);
                                        }}
                                        placeholder={t`Enter your name`}
                                        value={field.state.value}
                                    />
                                </field.FormControl>

                                <field.FormMessage className={classNames?.error} />
                            </field.FormItem>
                        )}
                    </form.AppField>
                )}

                {usernameEnabled && (
                    <form.AppField name="username">
                        {(field) => (
                            <field.FormItem>
                                <field.FormLabel className={classNames?.label}>{t`Username`}</field.FormLabel>

                                <field.FormControl>
                                    <Input
                                        autoComplete="username"
                                        className={classNames?.input}
                                        disabled={isSubmitting}
                                        onBlur={field.handleBlur}
                                        onChange={(e) => {
                                            field.handleChange(e.target.value);
                                        }}
                                        placeholder={t`Enter your username`}
                                        value={field.state.value}
                                    />
                                </field.FormControl>

                                <field.FormMessage className={classNames?.error} />
                            </field.FormItem>
                        )}
                    </form.AppField>
                )}

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

                <form.AppField name="password">
                    {(field) => (
                        <field.FormItem>
                            <field.FormLabel className={classNames?.label}>{t`Password`}</field.FormLabel>

                            <field.FormControl>
                                <PasswordInput
                                    autoComplete="new-password"
                                    className={classNames?.input}
                                    disabled={isSubmitting}
                                    enableToggle
                                    onBlur={field.handleBlur}
                                    onChange={(e) => {
                                        field.handleChange(e.target.value);
                                    }}
                                    placeholder={t`Enter your password`}
                                    value={field.state.value}
                                />
                            </field.FormControl>

                            <field.FormMessage className={classNames?.error} />
                        </field.FormItem>
                    )}
                </form.AppField>

                {confirmPasswordEnabled && (
                    <form.AppField name="confirmPassword">
                        {(field) => (
                            <field.FormItem>
                                <field.FormLabel className={classNames?.label}>{t`Confirm Password`}</field.FormLabel>

                                <field.FormControl>
                                    <PasswordInput
                                        autoComplete="new-password"
                                        className={classNames?.input}
                                        disabled={isSubmitting}
                                        enableToggle
                                        onBlur={field.handleBlur}
                                        onChange={(e) => {
                                            field.handleChange(e.target.value);
                                        }}
                                        placeholder={t`Enter your password again`}
                                        value={field.state.value}
                                    />
                                </field.FormControl>

                                <field.FormMessage className={classNames?.error} />
                            </field.FormItem>
                        )}
                    </form.AppField>
                )}

                {signUpFields?.map((field) => {
                    if (field === "name" || field === "image") {
                        return null;
                    }

                    const additionalField = additionalFields?.[field];

                    if (!additionalField) {
                        console.error(`Additional field ${field} not found`);

                        return null;
                    }

                    return additionalField.type === "boolean" ? (
                        <form.AppField key={field} name={field}>
                            {(formField) => (
                                <formField.FormItem className="flex">
                                    <formField.FormControl>
                                        <Checkbox
                                            checked={formField.state.value}
                                            disabled={isSubmitting}
                                            onCheckedChange={(checked) => {
                                                formField.handleChange(checked === true);
                                            }}
                                        />
                                    </formField.FormControl>

                                    <formField.FormLabel className={classNames?.label}>{String(additionalField.label || "")}</formField.FormLabel>

                                    <formField.FormMessage className={classNames?.error} />
                                </formField.FormItem>
                            )}
                        </form.AppField>
                    ) : (
                        <form.AppField key={field} name={field}>
                            {(formField) => (
                                <formField.FormItem>
                                    <formField.FormLabel className={classNames?.label}>{String(additionalField.label || "")}</formField.FormLabel>

                                    <formField.FormControl>
                                        <Input
                                            className={classNames?.input}
                                            disabled={isSubmitting}
                                            onBlur={formField.handleBlur}
                                            onChange={(e) => {
                                                formField.handleChange(e.target.value);
                                            }}
                                            placeholder={
                                                additionalField.placeholder || (typeof additionalField.label === "string" ? additionalField.label : "")
                                            }
                                            type={additionalField.type === "number" ? "number" : "text"}
                                            value={formField.state.value}
                                        />
                                    </formField.FormControl>

                                    <formField.FormMessage className={classNames?.error} />
                                </formField.FormItem>
                            )}
                        </form.AppField>
                    );
                })}

                <Captcha action="/sign-up/email" ref={captchaRef} />

                <form.Subscribe
                    selector={(state) => {
                        return { canSubmit: state.canSubmit, isSubmitting: state.isSubmitting };
                    }}
                >
                    {({ canSubmit, isSubmitting: isSubmittingState }) => (
                        <Button
                            className={cn("w-full", classNames?.button, classNames?.primaryButton)}
                            disabled={!canSubmit || isSubmittingState}
                            type="submit"
                        >
                            {isSubmittingState ? <Loader2 className="animate-spin" /> : t`Sign Up`}
                        </Button>
                    )}
                </form.Subscribe>
            </form>
        </form.AppForm>
    );
};

export default SignUpForm;
