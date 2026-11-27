"use client";

import { useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@neore/ui/components/responsive-dropdown-menu";
import { Trash2Icon, UploadCloudIcon } from "lucide-react";
import { useRef, useState } from "react";

import type { SettingsCardClassNames, SettingsCardProperties } from "@/components/settings/settings-card";
import SettingsCard from "@/components/settings/settings-card";
import SettingsRow from "@/components/settings/settings-row";
import { useActiveOrganization, useHasPermission, useListOrganizations } from "@/features/auth/hooks/organization-management";
import { useAuth } from "@/features/auth/lib/auth-ui-provider";

import { fileToBase64, resizeAndCropImage } from "../../lib/image-utilities";
import { getLocalizedError } from "../../lib/utilities";
import { hideCardHeader } from "../settings/settings-field-row";
import OrganizationLogo from "./organization-logo";

export interface OrganizationLogoCardProperties extends SettingsCardProperties {
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
        <SettingsCard className={className} classNames={hideCardHeader(classNames)} isPending={isPending} {...properties}>
            <SettingsRow
                control={
                    <>
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

                        <DropdownMenu>
                            <DropdownMenuTrigger
                                render={
                                    <Button className="size-fit rounded-full" disabled={!hasPermission?.success} size="icon" type="button" variant="ghost">
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

                            <DropdownMenuContent align="end">
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
                    </>
                }
                description={
                    <>
                        {t`Upload your organization's logo`}
                        <span className="mt-1 block">{t`Click on the logo to upload a new image`}</span>
                    </>
                }
                title={t`Logo`}
            />
        </SettingsCard>
    );
};

const OrganizationLogoCard = ({ className, classNames, ...properties }: OrganizationLogoCardProperties) => {
    const { authClient } = useAuth();
    const { t } = useLingui();

    const { data: activeOrganization } = useActiveOrganization(authClient);

    if (!activeOrganization) {
        return (
            <SettingsCard className={className} classNames={hideCardHeader(classNames)} isPending {...properties}>
                <SettingsRow
                    control={
                        <Button className="size-fit rounded-full" disabled size="icon" type="button" variant="ghost">
                            <OrganizationLogo className="size-20 text-2xl" classNames={undefined} isPending />
                        </Button>
                    }
                    description={t`Upload your organization's logo`}
                    title={t`Logo`}
                />
            </SettingsCard>
        );
    }

    return <OrganizationLogoForm className={className} classNames={classNames} {...properties} />;
};

export default OrganizationLogoCard;
