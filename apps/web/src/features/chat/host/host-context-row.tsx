"use client";

import { useLingui } from "@lingui/react/macro";
import { Bot, FolderOpen, Monitor } from "lucide-react";
import type { FC } from "react";

import ComposerChip from "@/features/chat/thread/composer-chip";

interface HostContextRowProps {
    /** The coding agent's name. */
    agentLabel: string;
    /** The computer's name; `undefined` while the device list loads, `null` once it is read and the computer is not in it. */
    deviceName: string | null | undefined;
    folderLabel: string;
}

/**
 * Where the coding agent works, under the message box: the computer, the folder and the agent. It states what the thread's Context
 * panel shows, next to the box a person types in. It leaves out the computer until the device list has answered.
 */
const HostContextRow: FC<HostContextRowProps> = ({ agentLabel, deviceName, folderLabel }) => {
    const { t } = useLingui();

    return (
        <div aria-label={t`Context`} className="flex flex-wrap items-center gap-1.5" role="group">
            {deviceName !== undefined && (
                <ComposerChip>
                    <Monitor aria-hidden="true" className="size-3 shrink-0" />
                    <span className="sr-only">{t`Computer`}</span>
                    <span className="truncate">{deviceName ?? t`Device removed`}</span>
                </ComposerChip>
            )}
            <ComposerChip>
                <FolderOpen aria-hidden="true" className="size-3 shrink-0" />
                <span className="truncate font-mono">{folderLabel}</span>
            </ComposerChip>
            <ComposerChip>
                <Bot aria-hidden="true" className="size-3 shrink-0" />
                <span className="truncate">{agentLabel}</span>
            </ComposerChip>
        </div>
    );
};

export default HostContextRow;
