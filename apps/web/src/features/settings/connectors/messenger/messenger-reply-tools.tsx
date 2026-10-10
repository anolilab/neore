"use client";

import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import type { MessengerReplyToolGroup } from "@neore/backend/messenger/reply-tools";
import { MESSENGER_REPLY_TOOL_GROUPS } from "@neore/backend/messenger/reply-tools";
import { Checkbox } from "@neore/ui/components/checkbox";
import { Label } from "@neore/ui/components/label";
import { Switch } from "@neore/ui/components/switch";
import type { FC } from "react";
import { useId } from "react";
import { toast } from "sonner";

import { useUpdateMessengerReplyTools } from "./hooks/use-messenger-connections";

const GROUP_LABELS: Record<MessengerReplyToolGroup, MessageDescriptor> = {
    codeExecution: msg`Code execution and sandbox files`,
    connectors: msg`Your connectors and MCP tools set to "Auto"`,
    dateTime: msg`Date and time`,
    imageGeneration: msg`Image generation`,
    knowledge: msg`Knowledge search`,
    urlFetch: msg`Open links`,
    webSearch: msg`Web search`,
};

interface MessengerReplyToolsProps {
    connectionId: string;
    disabled?: boolean;
    replyTools: { enabled: boolean; groups: string[] };
}

/**
 * The connection's reply-tool setting: a switch and the groups it allows. Off
 * by default; tools set to "Ask" never run here, since nobody can approve them.
 */
const MessengerReplyTools: FC<MessengerReplyToolsProps> = ({ connectionId, disabled, replyTools }) => {
    const { i18n, t } = useLingui();
    const id = useId();
    const update = useUpdateMessengerReplyTools();
    const groups = new Set(replyTools.groups);

    const save = async (next: { enabled: boolean; groups: string[] }) => {
        try {
            await update.mutateAsync({ connectionId: connectionId as never, ...next });
        } catch (error) {
            toast.error(error instanceof Error ? error.message : t`Failed to update reply tools`);
        }
    };

    const toggleGroup = (group: MessengerReplyToolGroup, checked: boolean) => {
        const next = MESSENGER_REPLY_TOOL_GROUPS.filter((candidate) => (candidate === group ? checked : groups.has(candidate)));

        void save({ enabled: replyTools.enabled, groups: next });
    };

    const isDisabled = disabled === true || update.isPending;

    return (
        <div aria-labelledby={`${id}-label`} className="space-y-2" role="group">
            <div className="flex items-start justify-between gap-4">
                <div className="space-y-0.5">
                    <Label className="text-xs" htmlFor={`${id}-switch`} id={`${id}-label`}>
                        {t`Let replies use tools`}
                    </Label>
                    <p className="text-muted-foreground text-xs">
                        {t`Replies can search, generate images and more, charged to your account. Tools set to "Ask" are skipped — nobody can approve them in a messenger.`}
                    </p>
                </div>
                <Switch
                    checked={replyTools.enabled}
                    disabled={isDisabled}
                    id={`${id}-switch`}
                    onCheckedChange={(checked) => {
                        void save({ enabled: checked, groups: replyTools.groups });
                    }}
                />
            </div>
            {replyTools.enabled && (
                <ul className="space-y-1.5">
                    {MESSENGER_REPLY_TOOL_GROUPS.map((group) => (
                        <li className="flex items-center gap-2" key={group}>
                            <Checkbox
                                checked={groups.has(group)}
                                disabled={isDisabled}
                                id={`${id}-${group}`}
                                onCheckedChange={(checked) => toggleGroup(group, checked === true)}
                            />
                            <Label className="text-xs font-normal" htmlFor={`${id}-${group}`}>
                                {i18n._(GROUP_LABELS[group])}
                            </Label>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
};

export default MessengerReplyTools;
