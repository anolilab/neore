"use client";

import { Trans, useLingui } from "@lingui/react/macro";
import { Alert, AlertDescription } from "@neore/ui/components/alert";
import { Button } from "@neore/ui/components/button";
import { RadioGroup, RadioGroupItem } from "@neore/ui/components/radio-group";
import { Switch } from "@neore/ui/components/switch";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Info } from "lucide-react";
import type { FC } from "react";
import { toast } from "sonner";

import SettingsCard from "@/components/settings/settings-card";
import SettingsRow from "@/components/settings/settings-row";
import { useCRPC } from "@/lib/lunora/crpc";

type BrowserClickMode = "page" | "pointer" | "all";

/** The stored click mode as one of the three modes; anything else (an unset or unknown value) is the safe default, "page". */
const toBrowserClickMode = (value: unknown): BrowserClickMode => {
    if (value === "pointer" || value === "all") {
        return value;
    }

    return "page";
};

/**
 * Agent Settings Component
 * Controls advanced AI agent capabilities for systematic task execution.
 */
const AgentSettings: FC = () => {
    const { t } = useLingui();
    const crpc = useCRPC();
    const queryClient = useQueryClient();
    const {
        data: aiPreferences,
        isError: isAIPreferencesError,
        isLoading,
        refetch: refetchAIPreferences,
    } = useQuery(crpc.auth.functions.getAIUserPreferences.queryOptions({}));
    const updateAIUserPreferencesMutation = useMutation(crpc.auth.functions.updateAIUserPreferences.mutationOptions());
    // Server-written (not in the generic settings save): the commit identity has its own setter.
    const setCommitIdentityMutation = useMutation(
        crpc.coding_agents.functions.setCodingAgentCommitIdentity.mutationOptions({
            onError: () => {
                toast.error(t`Failed to update pull request settings`);
            },
            onSuccess: () => {
                void queryClient.invalidateQueries({ queryKey: crpc.auth.functions.getAIUserPreferences.queryKey({}) });
                toast.success(t`Pull request settings updated`);
            },
        }),
    );

    const browserClickModeOptions: ReadonlyArray<{ description: string; label: string; mode: BrowserClickMode }> = [
        {
            description: t`The page is checked and clicked in one step, so nothing can change between them. Hover and press handlers respond. Popups and checks that need a real click may not work.`,
            label: t`Checked in the page (recommended)`,
            mode: "page",
        },
        {
            description: t`Ordinary buttons and links are checked, then clicked for real, so popups and real-click checks work. A page can change one in the moment between that check and the press, and that press is not checked again, so an ordinary button can become a purchase unseen. Purchases you approve are still checked in the page.`,
            label: t`Real clicks, purchases checked in the page`,
            mode: "pointer",
        },
        {
            description: t`Ordinary clicks are checked, then made for real. A page can change an ordinary button between the check and the press, so it can become a purchase unseen. Purchases you approve are still checked in the page.`,
            label: t`Real clicks for everything`,
            mode: "all",
        },
    ];

    // Server-written too: how the agent's browser clicks has its own setter, like the commit identity.
    const setBrowserClickModeMutation = useMutation(
        crpc.chat.functions.setBrowserClickMode.mutationOptions({
            onError: () => {
                toast.error(t`Failed to update browser click settings`);
            },
            onSuccess: () => {
                void queryClient.invalidateQueries({ queryKey: crpc.auth.functions.getAIUserPreferences.queryKey({}) });
                toast.success(t`Browser click settings updated`);
            },
        }),
    );

    if (isLoading) {
        return <div className="text-muted-foreground text-sm">{t`Loading...`}</div>;
    }

    const handleToggle = (field: string, value: boolean) => {
        updateAIUserPreferencesMutation.mutate(
            { [field]: value },
            {
                onError: () => {
                    toast.error(t`Failed to update agent settings`);
                },
                onSuccess: () => {
                    toast.success(t`Agent settings updated`);
                },
            },
        );
    };

    return (
        <div className="space-y-8">
            <Alert>
                <Info aria-hidden="true" className="h-4 w-4" />
                <AlertDescription>
                    <Trans>
                        The agent loop is always enabled for systematic task execution. These settings control additional specialized modules that enhance the
                        AI&apos;s capabilities for specific task types.
                    </Trans>
                </AlertDescription>
            </Alert>

            <SettingsCard description={t`Enable specialized modules to enhance AI capabilities`} title={t`Agent Modules`}>
                <SettingsRow
                    control={
                        <Switch
                            checked={aiPreferences?.enablePlanner ?? false}
                            disabled={updateAIUserPreferencesMutation.isPending}
                            id="enablePlanner"
                            onCheckedChange={(checked: boolean) => handleToggle("enablePlanner", checked)}
                        />
                    }
                    description={t`Break down complex tasks into numbered steps with progress tracking. Ideal for multi-step projects and development tasks.`}
                    htmlFor="enablePlanner"
                    title={t`Task Planning Module`}
                />
                <SettingsRow
                    control={
                        <Switch
                            checked={aiPreferences?.enableKnowledge ?? false}
                            disabled={updateAIUserPreferencesMutation.isPending}
                            id="enableKnowledge"
                            onCheckedChange={(checked: boolean) => handleToggle("enableKnowledge", checked)}
                        />
                    }
                    description={t`Apply best practices, patterns, and domain-specific guidelines. Enhances responses with expert knowledge and proven approaches.`}
                    htmlFor="enableKnowledge"
                    title={t`Knowledge Module`}
                />
                <SettingsRow
                    control={
                        <Switch
                            checked={aiPreferences?.enableDatasource ?? false}
                            disabled={updateAIUserPreferencesMutation.isPending}
                            id="enableDatasource"
                            onCheckedChange={(checked: boolean) => handleToggle("enableDatasource", checked)}
                        />
                    }
                    description={t`Validate data quality and prioritize authoritative sources. Essential for research tasks and fact-checking.`}
                    htmlFor="enableDatasource"
                    title={t`Data Source Module`}
                />
                <SettingsRow
                    control={
                        <Switch
                            checked={aiPreferences?.autoMediaEnrichment ?? false}
                            disabled={updateAIUserPreferencesMutation.isPending}
                            id="autoMediaEnrichment"
                            onCheckedChange={(checked: boolean) => handleToggle("autoMediaEnrichment", checked)}
                        />
                    }
                    description={t`Automatically include relevant images and videos alongside text responses when using search modes.`}
                    htmlFor="autoMediaEnrichment"
                    title={t`Auto Media Enrichment`}
                />
            </SettingsCard>

            <SettingsCard description={t`Automatically enable modules based on task complexity`} title={t`Automation`}>
                <SettingsRow
                    control={
                        <Switch
                            checked={aiPreferences?.autoDetectComplexity ?? false}
                            disabled={updateAIUserPreferencesMutation.isPending}
                            id="autoDetectComplexity"
                            onCheckedChange={(checked: boolean) => handleToggle("autoDetectComplexity", checked)}
                        />
                    }
                    description={
                        <Trans>
                            Automatically enable appropriate modules based on detected task type. Simplifies usage by intelligently activating features when
                            needed.
                        </Trans>
                    }
                    htmlFor="autoDetectComplexity"
                    title={t`Auto-Detect Task Complexity`}
                />
            </SettingsCard>

            <SettingsCard description={t`Who a pull request's commits are made as`} title={t`Coding Agent Pull Requests`}>
                <SettingsRow
                    control={
                        <Switch
                            aria-describedby="commitAsMeDescription"
                            checked={aiPreferences?.codingAgentCommitIdentity === "user"}
                            disabled={setCommitIdentityMutation.isPending || isAIPreferencesError}
                            id="commitAsMe"
                            onCheckedChange={(checked: boolean) => setCommitIdentityMutation.mutate({ identity: checked ? "user" : "agent" })}
                        />
                    }
                    description={t`Commits are made under your name and email, with Neore Agent listed as co-author. Off keeps the agent as the author, and so does an account without a name or a verified email.`}
                    descriptionId="commitAsMeDescription"
                    htmlFor="commitAsMe"
                    title={t`Commit as me`}
                >
                    <p className="text-destructive text-sm empty:-mt-3 empty:h-0" id="commitAsMeError" role="status">
                        {isAIPreferencesError ? t`Something went wrong. Try again.` : null}
                    </p>
                    {isAIPreferencesError ? (
                        <Button aria-describedby="commitAsMeError" className="mt-2" onClick={() => refetchAIPreferences()} size="sm" variant="outline">
                            {t`Retry`}
                        </Button>
                    ) : null}
                </SettingsRow>
            </SettingsCard>

            <SettingsCard
                description={t`How the agent's browser presses buttons and links`}
                title={<span id="browserClickModeTitle">{t`Browser Clicks`}</span>}
            >
                <div className="py-3">
                    <RadioGroup
                        aria-labelledby="browserClickModeTitle"
                        className="gap-4"
                        disabled={setBrowserClickModeMutation.isPending || isAIPreferencesError}
                        onValueChange={(value: unknown) => setBrowserClickModeMutation.mutate({ mode: toBrowserClickMode(value) })}
                        value={toBrowserClickMode(aiPreferences?.browserClickMode)}
                    >
                        {browserClickModeOptions.map((option) => (
                            <label className="flex cursor-pointer items-start gap-3" htmlFor={`browser-click-mode-${option.mode}`} key={option.mode}>
                                <RadioGroupItem className="mt-0.5" id={`browser-click-mode-${option.mode}`} value={option.mode} />
                                <span className="min-w-0 flex-1 space-y-1">
                                    <span className="block text-sm font-medium">{option.label}</span>
                                    <span className="text-muted-foreground block text-xs">{option.description}</span>
                                </span>
                            </label>
                        ))}
                    </RadioGroup>
                </div>
            </SettingsCard>

            <SettingsCard description={t`Estimated token cost per conversation`} title={t`Token Cost Impact`}>
                <div className="text-muted-foreground py-3 text-sm">
                    <ul className="list-disc space-y-2 pl-5">
                        <li>{t`Base (agent loop only): ~2,300 tokens`}</li>
                        <li>{t`+ Task Planning: ~2,500 tokens (+200)`}</li>
                        <li>{t`+ Knowledge: ~2,600 tokens (+100)`}</li>
                        <li>{t`+ Data Source: ~2,700 tokens (+100)`}</li>
                    </ul>
                    <p className="mt-4 text-xs">
                        {t`Note: Modules are applied per conversation, not per message. Enable only the modules you need to optimize token usage.`}
                    </p>
                </div>
            </SettingsCard>
        </div>
    );
};

export default AgentSettings;
