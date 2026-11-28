"use client";

import { useLingui } from "@lingui/react/macro";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@neore/ui/components/select";
import type { FC } from "react";

import SettingsRow from "@/components/settings/settings-row";
import type { ChatOpenPlace } from "@/features/chat/split/chat-open-place";
import { readChatOpenPlace } from "@/features/chat/split/chat-open-place";
import { useUIStateStore } from "@/features/layout/stores/ui-state-store";

/**
 * Where a click on a sub-agent opens its chat. Saved in this browser only, like the split view it relies on.
 */
const SubAgentOpenPlaceSettings: FC = () => {
    const { t } = useLingui();
    const place = useUIStateStore((state) => readChatOpenPlace(state.preferences.subAgentOpenPlace));
    const setUserPreferences = useUIStateStore((state) => state.setUserPreferences);

    const labels: Record<ChatOpenPlace, string> = {
        main: t`Main view`,
        side: t`Side panel`,
    };

    return (
        <SettingsRow
            control={
                <Select<ChatOpenPlace>
                    onValueChange={(next) => {
                        if (next === "main" || next === "side") {
                            setUserPreferences({ subAgentOpenPlace: next });
                        }
                    }}
                    value={place}
                >
                    <SelectTrigger aria-describedby="sub-agent-open-place-description" className="w-44 shrink-0" id="sub-agent-open-place">
                        <SelectValue>{(value: ChatOpenPlace | null) => labels[value ?? "side"]}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value="side">{labels.side}</SelectItem>
                        <SelectItem value="main">{labels.main}</SelectItem>
                    </SelectContent>
                </Select>
            }
            description={t`Hold Ctrl, Cmd or the middle mouse button to open it in the other place. The side panel needs Split View, turned on in Account settings.`}
            descriptionId="sub-agent-open-place-description"
            htmlFor="sub-agent-open-place"
            title={t`Where a sub-agent or side chat opens`}
        />
    );
};

export default SubAgentOpenPlaceSettings;
