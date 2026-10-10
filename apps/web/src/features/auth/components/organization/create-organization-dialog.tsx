"use client";

import { useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { useAppForm } from "@neore/ui/components/form";
import { Input } from "@neore/ui/components/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@neore/ui/components/responsive-dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@neore/ui/components/responsive-dropdown-menu";
import cn from "@neore/ui/utils/cn";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2Icon, Loader2, Trash2Icon, UploadCloudIcon, XCircleIcon } from "lucide-react";
import type { ComponentProps } from "react";
import { useEffect, useRef, useState } from "react";
import * as z from "zod";

import type { SettingsCardClassNames } from "@/components/settings/settings-card";
import { useActiveOrganization, useListOrganizations } from "@/features/auth/hooks/organization-management";
import { useAuth } from "@/features/auth/lib/auth-ui-provider";
import { useCRPC } from "@/lib/lunora/crpc";

import { fileToBase64, resizeAndCropImage } from "../../lib/image-utilities";
import { getLocalizedError } from "../../lib/utilities";
import OrganizationLogo from "./organization-logo";

const ORGANIZATION_SLUG_RE = /^[a-z0-9-]+$/;

export interface CreateOrganizationDialogProperties extends ComponentProps<typeof Dialog> {
    className?: string;
    classNames?: SettingsCardClassNames;
}

const CreateOrganizationDialog = ({ className: _className, classNames, onOpenChange, ...properties }: CreateOrganizationDialogProperties) => {
    const { authClient, organization, toast } = useAuth();
    const { t } = useLingui();
    const crpc = useCRPC();

    const [logo, setLogo] = useState<string | null>(null);
    const [uploadingLogo, setUploadingLogo] = useState(false);
    const [slugToCheck, setSlugToCheck] = useState<string>("");
    const [debouncedSlug, setDebouncedSlug] = useState<string>("");

    const fileInputReference = useRef<HTMLInputElement>(null);
    const openFileDialog = () => fileInputReference.current?.click();

    const { refetch: refetchActiveOrganization } = useActiveOrganization(authClient);
    const { refetch: refetchOrganizations } = useListOrganizations(authClient);

    // Debounce slug checking
    useEffect(() => {
        const timer = setTimeout(() => {
            if (slugToCheck && slugToCheck.length >= 3 && ORGANIZATION_SLUG_RE.test(slugToCheck)) {
                setDebouncedSlug(slugToCheck);
            } else {
                setDebouncedSlug("");
            }
        }, 500);

        return () => clearTimeout(timer);
    }, [slugToCheck]);

    // Check slug availability
    const { data: slugAvailability, isFetching: isCheckingSlug } = useQuery({
        ...crpc.auth.organization.checkSlug.queryOptions({ slug: debouncedSlug }),
        enabled: debouncedSlug.length >= 3,
    });

    const formSchema = z.strictObject({
        logo: z.string().optional(),
        name: z.string().min(1, {
            message: t`Organization name is required`,
        }),
        slug: z
            .string()
            .min(1, {
                message: t`Organization slug is required`,
            })
            .regex(ORGANIZATION_SLUG_RE, {
                message: t`Organization slug is invalid`,
            }),
    });

    const form = useAppForm({
        defaultValues: {
            logo: "",
            name: "",
            slug: "",
        },
        onSubmit: async ({ value }) => {
            // Reset slug check state immediately to prevent "taken" message flash
            setSlugToCheck("");
            setDebouncedSlug("");

            try {
                const createdOrganization = await authClient.organization.create({
                    fetchOptions: { throw: true },
                    logo: value.logo,
                    name: value.name,
                    slug: value.slug,
                });

                await authClient.organization.setActive({
                    organizationId: createdOrganization.id,
                });

                await refetchActiveOrganization?.();
                await refetchOrganizations?.();
                onOpenChange?.(false);
                form.reset();
                setLogo(null);

                toast({
                    message: t`Organization created successfully`,
                    variant: "success",
                });
            } catch (error) {
                toast({
                    message: getLocalizedError({ error, t }),
                    variant: "error",
                });
            }
        },
        validators: {
            onChange: ({ value }) => {
                const result = formSchema.safeParse(value);

                if (!result.success) {
                    return z.treeifyError(result.error);
                }

                return undefined;
            },
        },
    });

    const handleLogoChange = async (file: File) => {
        if (!organization?.logo) {
            return;
        }

        setUploadingLogo(true);

        try {
            const resizedFile = await resizeAndCropImage(file, crypto.randomUUID(), organization.logo.size, organization.logo.extension);

            const image: string | undefined | null = await (organization?.logo.upload ? organization.logo.upload(resizedFile) : fileToBase64(resizedFile));

            setLogo(image || null);
            form.setFieldValue("logo", image || "");
        } catch (error) {
            toast({
                message: getLocalizedError({ error, t }),
                variant: "error",
            });
        }

        setUploadingLogo(false);
    };

    const deleteLogo = () => {
        setLogo(null);
        form.setFieldValue("logo", "");
    };

    return (
        <Dialog onOpenChange={onOpenChange} {...properties}>
            <DialogContent className={classNames?.dialog?.content}>
                <DialogHeader className={classNames?.dialog?.header}>
                    <DialogTitle className={cn("text-lg md:text-xl", classNames?.title)}>{t`Create Organization`}</DialogTitle>

                    <DialogDescription className={cn("text-xs md:text-sm", classNames?.description)}>
                        {t`Create a new organization to collaborate with your team`}
                    </DialogDescription>
                </DialogHeader>

                <form.AppForm>
                    <form
                        className="space-y-6"
                        onSubmit={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            form.handleSubmit();
                        }}
                    >
                        {organization?.logo && (
                            <form.AppField name="logo">
                                {() => (
                                    <div className="space-y-2">
                                        <input
                                            accept="image/*"
                                            disabled={uploadingLogo}
                                            hidden
                                            onChange={(e) => {
                                                const file = e.target.files?.item(0);

                                                if (file) {
                                                    handleLogoChange(file);
                                                }

                                                e.target.value = "";
                                            }}
                                            ref={fileInputReference}
                                            type="file"
                                        />

                                        <span
                                            className="text-sm leading-none font-medium peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
                                            id="org-logo-label"
                                        >
                                            {t`Logo`}
                                        </span>

                                        <div aria-labelledby="org-logo-label" className="flex items-center gap-4" role="group">
                                            <DropdownMenu>
                                                <DropdownMenuTrigger
                                                    render={
                                                        <Button className="size-fit rounded-full" size="icon" type="button" variant="ghost">
                                                            <form.Subscribe>
                                                                {({ values }) => (
                                                                    <OrganizationLogo
                                                                        className="size-16"
                                                                        isPending={uploadingLogo}
                                                                        organization={
                                                                            logo
                                                                                ? {
                                                                                      logo,
                                                                                      name: values.name,
                                                                                  }
                                                                                : null
                                                                        }
                                                                    />
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
                                                    <DropdownMenuItem disabled={uploadingLogo} onClick={openFileDialog}>
                                                        <UploadCloudIcon />
                                                        {t`Upload Logo`}
                                                    </DropdownMenuItem>

                                                    {logo && (
                                                        <DropdownMenuItem disabled={uploadingLogo} onClick={deleteLogo} variant="destructive">
                                                            <Trash2Icon />
                                                            {t`Delete Logo`}
                                                        </DropdownMenuItem>
                                                    )}
                                                </DropdownMenuContent>
                                            </DropdownMenu>

                                            <Button disabled={uploadingLogo} onClick={openFileDialog} type="button" variant="outline">
                                                {uploadingLogo && <Loader2 className="animate-spin" />}

                                                {t`Upload`}
                                            </Button>
                                        </div>
                                    </div>
                                )}
                            </form.AppField>
                        )}

                        <form.AppField name="name">
                            {(field) => (
                                <field.FormItem>
                                    <field.FormLabel>{t`Organization Name`}</field.FormLabel>

                                    <field.FormControl>
                                        <Input
                                            onBlur={field.handleBlur}
                                            onChange={(e) => {
                                                field.handleChange(e.target.value);
                                            }}
                                            placeholder={t`Enter organization name`}
                                            value={field.state.value}
                                        />
                                    </field.FormControl>

                                    <field.FormMessage />
                                </field.FormItem>
                            )}
                        </form.AppField>

                        <form.AppField name="slug">
                            {(field) => (
                                <field.FormItem>
                                    <field.FormLabel>{t`Organization Slug`}</field.FormLabel>

                                    <field.FormControl>
                                        <div className="relative">
                                            <Input
                                                onBlur={field.handleBlur}
                                                onChange={(e) => {
                                                    const value = e.target.value.toLowerCase();

                                                    field.handleChange(value);
                                                    setSlugToCheck(value);
                                                }}
                                                placeholder={t`Enter organization slug`}
                                                value={field.state.value}
                                            />
                                            {field.state.value && field.state.value.length >= 3 && ORGANIZATION_SLUG_RE.test(field.state.value) && (
                                                <div className="absolute top-1/2 right-3 -translate-y-1/2">
                                                    {isCheckingSlug && <Loader2 className="text-muted-foreground size-4 animate-spin" />}
                                                    {!isCheckingSlug && slugAvailability?.available === true && (
                                                        <CheckCircle2Icon className="size-4 text-green-500" />
                                                    )}
                                                    {!isCheckingSlug && slugAvailability?.available === false && (
                                                        <XCircleIcon className="size-4 text-red-500" />
                                                    )}
                                                </div>
                                            )}
                                        </div>
                                    </field.FormControl>

                                    {field.state.value && field.state.value.length >= 3 && !isCheckingSlug && slugAvailability?.available === false && (
                                        <p className="text-destructive text-sm">{t`This slug is already taken`}</p>
                                    )}

                                    {field.state.value && field.state.value.length >= 3 && !isCheckingSlug && slugAvailability?.available && (
                                        <p className="text-sm text-green-600">{t`This slug is available`}</p>
                                    )}

                                    <field.FormMessage />
                                </field.FormItem>
                            )}
                        </form.AppField>

                        <DialogFooter className={classNames?.dialog?.footer}>
                            <Button
                                className={cn(classNames?.button, classNames?.outlineButton)}
                                onClick={() => onOpenChange?.(false)}
                                type="button"
                                variant="outline"
                            >
                                {t`Cancel`}
                            </Button>

                            <form.Subscribe selector={(state) => ({ canSubmit: state.canSubmit, isSubmitting: state.isSubmitting }) as unknown as typeof state}>
                                {({ canSubmit, isSubmitting }) => {
                                    const slugValue = form.getFieldValue("slug");
                                    const isSlugValid = slugValue && slugValue.length >= 3 && ORGANIZATION_SLUG_RE.test(slugValue);
                                    const isSlugAvailable = !isSlugValid || slugAvailability?.available === true;
                                    const canCreate = canSubmit && isSlugAvailable && !isCheckingSlug;

                                    return (
                                        <Button className={cn(classNames?.button, classNames?.primaryButton)} disabled={!canCreate} type="submit">
                                            {isSubmitting && <Loader2 className="animate-spin" />}

                                            {t`Create Organization`}
                                        </Button>
                                    );
                                }}
                            </form.Subscribe>
                        </DialogFooter>
                    </form>
                </form.AppForm>
            </DialogContent>
        </Dialog>
    );
};

export default CreateOrganizationDialog;
