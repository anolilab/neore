"use client";

import { useLingui } from "@lingui/react/macro";
import { Label } from "@neore/ui/components/label";
import { Switch } from "@neore/ui/components/switch";
import type { FC } from "react";
import { toast } from "sonner";

import { useUpdateUserSettings, useUserSettings } from "@/features/auth/hooks/use-user-settings";
import { chatActionConfirmations } from "@/features/chat/thread-list/lib/chat-action-confirmations";

type ConfirmSettingKey = "confirmBeforeArchiveChat" | "confirmBeforeDeleteChat" | "confirmBeforeUnpinChat";

interface ConfirmRowProperties {
    checked: boolean;
    description: string;
    id: string;
    label: string;
    onChange: (checked: boolean) => void;
}

const ConfirmRow: FC<ConfirmRowProperties> = ({ checked, description, id, label, onChange }) => (
    <div className="flex items-center justify-between">
        <div className="space-y-0.5">
            <Label className="text-base font-medium" htmlFor={id}>
                {label}
            </Label>
            <p className="text-muted-foreground text-sm" id={`${id}-description`}>
                {description}
            </p>
        </div>
        <Switch aria-describedby={`${id}-description`} checked={checked} id={id} onCheckedChange={onChange} />
    </div>
);

/**
 * Whether unpinning, archiving and deleting a chat asks first, mounted in the chat card. Each switch saves on its own,
 * through the settings write queue, so quick toggles of one switch land in the order they were made.
 * "Off" is sent as `false`, never `undefined`, because the server's patch treats `undefined` as "leave alone".
 */
const ChatActionConfirmControls: FC = () => {
    const { t } = useLingui();
    const { data: userSettings } = useUserSettings();
    const updateUserSettings = useUpdateUserSettings();
    const confirmations = chatActionConfirmations(userSettings);

    const save = (key: ConfirmSettingKey, checked: boolean) => {
        updateUserSettings
            .updateLatest(() => {
                return { [key]: checked };
            })
            .then(() => {
                toast.success(t`Settings saved`);

                return undefined;
            })
            .catch(() => {
                toast.error(t`Failed to save settings`);
            });
    };

    return (
        <>
            <ConfirmRow
                checked={confirmations.unpin}
                description={t`Asks before a pinned chat is unpinned. Off: unpinning happens on the first click.`}
                id="confirm-before-unpin-chat"
                label={t`Confirm before unpinning a chat`}
                onChange={(checked) => save("confirmBeforeUnpinChat", checked)}
            />
            <ConfirmRow
                checked={confirmations.archive}
                description={t`Asks before a chat is archived. Off: archiving happens on the first click.`}
                id="confirm-before-archive-chat"
                label={t`Confirm before archiving a chat`}
                onChange={(checked) => save("confirmBeforeArchiveChat", checked)}
            />
            <ConfirmRow
                checked={confirmations.delete}
                description={t`Asks before a chat is deleted. Off: deleting happens on the first click.`}
                id="confirm-before-delete-chat"
                label={t`Confirm before deleting a chat`}
                onChange={(checked) => save("confirmBeforeDeleteChat", checked)}
            />
        </>
    );
};

export default ChatActionConfirmControls;
