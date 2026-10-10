"use client";

import { useLingui } from "@lingui/react/macro";
import { Avatar, AvatarFallback, AvatarImage } from "@neore/ui/components/avatar";
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
import { useSession } from "@/features/auth/hooks/session-user-management";
import { useAuth } from "@/features/auth/lib/auth-ui-provider";

import { fileToBase64, resizeAndCropImage } from "../../../lib/image-utilities";
import { getLocalizedError } from "../../../lib/utilities";

export interface UpdateAvatarCardProperties extends ComponentProps<typeof Card> {
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
        <Card className={cn("w-full pb-0 text-start", className, classNames?.base)} {...properties}>
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

            <div className="flex justify-between">
                <SettingsCardHeader
                    className="grow self-start"
                    classNames={classNames}
                    description={t`Upload a profile picture for your account`}
                    isPending={isPending}
                    title={t`Avatar`}
                />

                <DropdownMenu>
                    <DropdownMenuTrigger
                        render={
                            <Button className="me-6 size-fit rounded-full" size="icon" variant="ghost">
                                <Avatar className="size-20 text-2xl">
                                    {sessionData?.user.image && <AvatarImage alt={sessionData?.user.name || t`User`} src={sessionData.user.image} />}
                                    <AvatarFallback className="rounded-lg" name={sessionData?.user.name || sessionData?.user.email || undefined}>
                                        {sessionData?.user.name?.charAt(0)?.toUpperCase() || "U"}
                                    </AvatarFallback>
                                </Avatar>
                            </Button>
                        }
                    />

                    <DropdownMenuContent
                        align="end"
                        onCloseAutoFocus={(e) => {
                            e.preventDefault();
                        }}
                    >
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
            </div>

            <SettingsCardFooter
                className="!py-5"
                classNames={classNames}
                instructions={t`Click the avatar to upload a new image or delete the current one`}
                isPending={isPending}
                isSubmitting={loading}
            />
        </Card>
    );
};

export default UpdateAvatarCard;
