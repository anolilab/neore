"use client";

import { useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { Card } from "@neore/ui/components/card";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@neore/ui/components/responsive-dropdown-menu";
import cn from "@neore/ui/utils/cn";
import { Trash2Icon, UploadCloudIcon } from "lucide-react";
import type { ComponentProps } from "react";
import { useRef, useState } from "react";

import type { SettingsCardClassNames } from "@/components/settings/settings-card";
import SettingsCardFooter from "@/components/settings/settings-card-footer";
import SettingsCardHeader from "@/components/settings/settings-card-header";
import { useActiveOrganization, useHasPermission, useListOrganizations } from "@/features/auth/hooks/organization-management";
import { useAuth } from "@/features/auth/lib/auth-ui-provider";

import { fileToBase64, resizeAndCropImage } from "../../lib/image-utilities";
import { getLocalizedError } from "../../lib/utilities";
import OrganizationLogo from "./organization-logo";

export interface OrganizationLogoCardProperties extends ComponentProps<typeof Card> {
    className?: string;
    classNames?: SettingsCardClassNames;
}

const OrganizationLogoForm = ({ className, classNames, ...properties }: OrganizationLogoCardProperties) => {
    const { authClient, optimistic, organization, toast } = useAuth();
    const { t } = useLingui();

    const { data: activeOrganization, refetch: refetchActiveOrganization } = useActiveOrganization(authClient);
    const { refetch: refetchOrganizations } = useListOrganizations(authClient);
    const { data: hasPermission, isPending: permissionPending } = useHasPermission(authClient, {
        permissions: {
            organization: ["update"],
        },
    });

    const isPending = !activeOrganization || permissionPending;

    const fileInputReference = useRef<HTMLInputElement | null>(null);
    const [loading, setLoading] = useState(false);

    const handleLogoChange = async (file: File) => {
        if (!activeOrganization || !organization?.logo || !hasPermission?.success) {
            return;
        }

        setLoading(true);

        try {
            const resizedFile = await resizeAndCropImage(file, crypto.randomUUID(), organization.logo.size, organization.logo.extension);
            const image = await (organization.logo.upload ? organization.logo.upload(resizedFile) : fileToBase64(resizedFile));

            if (!image) {
                return;
            }

            if (optimistic && !organization.logo.upload) {
                setLoading(false);
            }

            await authClient.organization.update({
                data: { logo: image },
                fetchOptions: { throw: true },
            });

            await refetchActiveOrganization?.();
            await refetchOrganizations?.();
        } catch (error) {
            toast({
                message: getLocalizedError({ error, t }),
                variant: "error",
            });
        } finally {
            setLoading(false);
        }
    };

    const handleDeleteLogo = async () => {
        if (!activeOrganization || !hasPermission?.success) {
            return;
        }

        setLoading(true);

        try {
            await authClient.organization.update({
                data: { logo: "" },
                fetchOptions: { throw: true },
            });

            await refetchActiveOrganization?.();
            await refetchOrganizations?.();
        } catch (error) {
            toast({
                message: getLocalizedError({ error, t }),
                variant: "error",
            });
        }

        setLoading(false);
    };

    const openFileDialog = () => {
        if (hasPermission?.success) {
            fileInputReference.current?.click();
        }
    };

    return (
        <Card className={cn("w-full pb-0 text-start", className, classNames?.base)} {...properties}>
            <input
                accept="image/*"
                disabled={loading || !hasPermission?.success}
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

            <div className="flex justify-between">
                <SettingsCardHeader
                    className="grow self-start"
                    classNames={classNames}
                    description={t`Upload your organization's logo`}
                    isPending={isPending}
                    title={t`Logo`}
                />

                <DropdownMenu>
                    <DropdownMenuTrigger
                        render={
                            <Button className="me-6 size-fit rounded-full" disabled={!hasPermission?.success} size="icon" type="button" variant="ghost">
                                <OrganizationLogo
                                    className="size-20 text-2xl"
                                    classNames={undefined}
                                    isPending={isPending || loading}
                                    key={activeOrganization?.logo}
                                    organization={activeOrganization}
                                />
                            </Button>
                        }
                    />

                    <DropdownMenuContent
                        align="end"
                        onCloseAutoFocus={(e) => {
                            e.preventDefault();
                        }}
                    >
                        <DropdownMenuItem disabled={loading || !hasPermission?.success} onClick={openFileDialog}>
                            <UploadCloudIcon />
                            {t`Upload Logo`}
                        </DropdownMenuItem>
                        {activeOrganization?.logo && (
                            <DropdownMenuItem disabled={loading || !hasPermission?.success} onClick={handleDeleteLogo} variant="destructive">
                                <Trash2Icon />
                                {t`Delete Logo`}
                            </DropdownMenuItem>
                        )}
                    </DropdownMenuContent>
                </DropdownMenu>
            </div>

            <SettingsCardFooter
                className="!py-5"
                classNames={classNames}
                instructions={t`Click on the logo to upload a new image`}
                isPending={isPending}
                isSubmitting={loading}
            />
        </Card>
    );
};

const OrganizationLogoCard = ({ className, classNames, ...properties }: OrganizationLogoCardProperties) => {
    const { authClient } = useAuth();
    const { t } = useLingui();

    const { data: activeOrganization } = useActiveOrganization(authClient);

    if (!activeOrganization) {
        return (
            <Card className={cn("w-full pb-0 text-start", className, classNames?.base)} {...properties}>
                <div className="flex justify-between">
                    <SettingsCardHeader
                        className="grow self-start"
                        classNames={classNames}
                        description={t`Upload your organization's logo`}
                        isPending
                        title={t`Logo`}
                    />

                    <Button className="me-6 size-fit rounded-full" disabled size="icon" type="button" variant="ghost">
                        <OrganizationLogo className="size-20 text-2xl" classNames={undefined} isPending />
                    </Button>
                </div>

                <SettingsCardFooter
                    className="!py-5"
                    classNames={classNames}
                    instructions={t`Click on the logo to upload a new image`}
                    isPending
                    isSubmitting={false}
                />
            </Card>
        );
    }

    return <OrganizationLogoForm className={className} classNames={classNames} {...properties} />;
};

export default OrganizationLogoCard;
