"use client";

import { useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { Label } from "@neore/ui/components/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@neore/ui/components/select";
import { Switch } from "@neore/ui/components/switch";
import { Textarea } from "@neore/ui/components/textarea";
import type { FC } from "react";
import { useState } from "react";
import { toast } from "sonner";

import { useUpdateUserSettings, useUserSettings } from "@/features/auth/hooks/use-user-settings";

const LINE_BREAK_RE = /\r?\n/;

/** Off, then the presets. Anything else the server refuses (7-365 whole days). */
const AUTO_ARCHIVE_DAYS = [0, 30, 90, 180, 365] as const;

/**
 * Chat lifecycle controls, mounted in the chat retention card: temporary chats
 * by default, auto-archive, and the web search domain blocklist. Each save is a
 * plain `updateUserSettings`; "off" is sent as `false` / `0` / `[]`, never
 * `undefined`, because the server's patch treats `undefined` as "leave alone".
 */
const ChatLifecycleControls: FC = () => {
    const { t } = useLingui();
    const { data: userSettings } = useUserSettings();
    const updateUserSettings = useUpdateUserSettings();
    // The textarea's text while it differs from the saved list; `undefined` shows the saved list.
    const [blocklistDraft, setBlocklistDraft] = useState<string | undefined>(undefined);

    const savedBlocklist = userSettings?.searchDomainBlocklist ?? [];
    const blocklistText = blocklistDraft ?? savedBlocklist.join("\n");
    const autoArchiveDays = userSettings?.autoArchiveAfterDays ?? 0;

    const save = (changes: Record<string, unknown>, successMessage: string, onSaved?: () => void) => {
        updateUserSettings.mutate(changes, {
            onError: (error) => {
                toast.error(error instanceof Error && error.message ? error.message : t`Failed to save settings`);
            },
            onSuccess: () => {
                onSaved?.();
                toast.success(successMessage);
            },
        });
    };

    return (
        <>
            <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                    <Label className="text-base font-medium" htmlFor="new-chats-temporary">
                        {t`Start new chats as temporary`}
                    </Label>
                    <p className="text-muted-foreground text-sm" id="new-chats-temporary-description">
                        {t`New chats are deleted automatically after the retention period above. You can make one permanent from its menu.`}
                    </p>
                </div>
                <Switch
                    aria-describedby="new-chats-temporary-description"
                    checked={userSettings?.newChatsTemporary === true}
                    id="new-chats-temporary"
                    onCheckedChange={(checked) => {
                        save({ newChatsTemporary: checked }, checked ? t`New chats start temporary` : t`New chats start permanent`);
                    }}
                />
            </div>

            <div className="space-y-2">
                <Label className="text-base font-medium" htmlFor="auto-archive-after-days">
                    {t`Auto-archive inactive chats`}
                </Label>
                <p className="text-muted-foreground text-sm" id="auto-archive-description">
                    {t`Chats with no activity for this long are archived. Archived chats stay searchable.`}
                </p>
                <Select
                    onValueChange={(value) => {
                        const days = Number(value);

                        save({ autoArchiveAfterDays: days }, days === 0 ? t`Auto-archive turned off` : t`Inactive chats will be archived after ${days} days`);
                    }}
                    value={String(autoArchiveDays)}
                >
                    <SelectTrigger aria-describedby="auto-archive-description" id="auto-archive-after-days">
                        <SelectValue>
                            {(value: string | null) => {
                                const days = Number(value);

                                return days === 0 ? t`Off` : t`${days} days`;
                            }}
                        </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                        {AUTO_ARCHIVE_DAYS.map((days) => (
                            <SelectItem key={days} value={String(days)}>
                                {days === 0 ? t`Off` : t`${days} days`}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            </div>

            <div className="space-y-2">
                <Label className="text-base font-medium" htmlFor="search-domain-blocklist">
                    {t`Blocked websites for web search`}
                </Label>
                <p className="text-muted-foreground text-sm" id="search-domain-blocklist-description">
                    {t`One domain per line, for example example.com. Results from these sites and their subdomains are never shown, even if the assistant asks for them.`}
                </p>
                <Textarea
                    aria-describedby="search-domain-blocklist-description"
                    id="search-domain-blocklist"
                    onChange={(event) => setBlocklistDraft(event.target.value)}
                    placeholder="example.com"
                    rows={4}
                    value={blocklistText}
                />
                <Button
                    disabled={updateUserSettings.isPending || blocklistDraft === undefined}
                    onClick={() => {
                        const lines = (blocklistDraft ?? "")
                            .split(LINE_BREAK_RE)
                            .map((line) => line.trim())
                            .filter((line) => line !== "");

                        save({ searchDomainBlocklist: lines }, t`Blocked websites saved`, () => setBlocklistDraft(undefined));
                    }}
                    size="sm"
                    type="button"
                    variant="outline"
                >
                    {t`Save blocked websites`}
                </Button>
            </div>
        </>
    );
};

export default ChatLifecycleControls;
