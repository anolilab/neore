"use client";

import { useLingui } from "@lingui/react/macro";
import { Avatar, AvatarFallback, AvatarImage } from "@neore/ui/components/avatar";
import { Button } from "@neore/ui/components/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@neore/ui/components/responsive-dropdown-menu";
import { Trash2Icon, UploadCloudIcon } from "lucide-react";
import { useRef, useState } from "react";

import type { SettingsCardClassNames, SettingsCardProperties } from "@/components/settings/settings-card";
import SettingsCard from "@/components/settings/settings-card";
import SettingsRow from "@/components/settings/settings-row";
import { useSession } from "@/features/auth/hooks/session-user-management";
import { useAuth } from "@/features/auth/lib/auth-ui-provider";

import { fileToBase64, resizeAndCropImage } from "../../../lib/image-utilities";
import { getLocalizedError } from "../../../lib/utilities";
import { hideCardHeader } from "../settings-field-row";

export interface UpdateAvatarCardProperties extends SettingsCardProperties {
    className?: string;
    classNames?: SettingsCardClassNames;
}

const UpdateAvatarCard = ({ className, classNames, ...properties }: UpdateAvatarCardProperties) => {
    const {
        authClient,
        avatar,
        mutators: { updateUser },
        optimistic,
        toast,
    } = useAuth();
    const { t } = useLingui();

    const { data: sessionData, isPending, refetch } = useSession(authClient);
    const fileInputReference = useRef<HTMLInputElement | null>(null);
    const [loading, setLoading] = useState(false);

    const handleAvatarChange = async (file: File) => {
        if (!sessionData || !avatar) {
            return;
        }

        setLoading(true);

        try {
            const resizedFile = await resizeAndCropImage(file, crypto.randomUUID(), avatar.size, avatar.extension);
            const image = await (avatar.upload ? avatar.upload(resizedFile) : fileToBase64(resizedFile));

            if (!image) {
                return;
            }

            if (optimistic && !avatar.upload) {
                setLoading(false);
            }

            await updateUser({ image });
            await refetch?.();
        } catch (error) {
            toast({
                message: getLocalizedError({ error, t }),
                variant: "error",
            });
        } finally {
            setLoading(false);
        }
    };

    const handleDeleteAvatar = async () => {
        if (!sessionData) {
            return;
        }

        setLoading(true);

        try {
            await updateUser({ image: null });
            await refetch?.();
        } catch (error) {
            toast({
                message: getLocalizedError({ error, t }),
                variant: "error",
            });
        } finally {
            setLoading(false);
        }
    };

    const openFileDialog = () => fileInputReference.current?.click();

    return (
        <SettingsCard className={className} classNames={hideCardHeader(classNames)} isPending={isPending} {...properties}>
            <SettingsRow
                control={
                    <>
                        <input
                            accept="image/*"
                            disabled={loading}
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

                        <DropdownMenu>
                            <DropdownMenuTrigger
                                render={
                                    <Button className="size-fit rounded-full" size="icon" variant="ghost">
                                        <Avatar className="size-20 text-2xl">
                                            {sessionData?.user.image && <AvatarImage alt={sessionData?.user.name || t`User`} src={sessionData.user.image} />}
                                            <AvatarFallback className="rounded-lg" name={sessionData?.user.name || sessionData?.user.email || undefined}>
                                                {sessionData?.user.name?.charAt(0)?.toUpperCase() || "U"}
                                            </AvatarFallback>
                                        </Avatar>
                                    </Button>
                                }
                            />

                            <DropdownMenuContent align="end">
                                <DropdownMenuItem disabled={loading} onClick={openFileDialog}>
                                    <UploadCloudIcon />
                                    {t`Upload Avatar`}
                                </DropdownMenuItem>
                                {sessionData?.user.image && (
                                    <DropdownMenuItem disabled={loading} onClick={handleDeleteAvatar} variant="destructive">
                                        <Trash2Icon />
                                        {t`Delete Avatar`}
                                    </DropdownMenuItem>
                                )}
                            </DropdownMenuContent>
                        </DropdownMenu>
                    </>
                }
                description={
                    <>
                        {t`Upload a profile picture for your account`}
                        <span className="mt-1 block">{t`Click the avatar to upload a new image or delete the current one`}</span>
                    </>
                }
                title={t`Avatar`}
            />
        </SettingsCard>
    );
};

export default UpdateAvatarCard;
