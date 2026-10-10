"use client";

import { Trans, useLingui } from "@lingui/react/macro";
import { Alert, AlertDescription } from "@neore/ui/components/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@neore/ui/components/card";
import { Heading, HeadingSection } from "@neore/ui/components/heading";
import { Label } from "@neore/ui/components/label";
import { Separator } from "@neore/ui/components/separator";
import { Switch } from "@neore/ui/components/switch";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Info } from "lucide-react";
import type { FC } from "react";
import { toast } from "sonner";

import { useCRPC } from "@/lib/lunora/crpc";

/**
 * Agent Settings Component
 * Controls advanced AI agent capabilities for systematic task execution.
 */
const AgentSettings: FC = () => {
    const { t } = useLingui();
    const crpc = useCRPC();
    const { data: aiPreferences, isLoading } = useQuery(crpc.auth.functions.getAIUserPreferences.queryOptions({}));
    const updateAIUserPreferencesMutation = useMutation(crpc.auth.functions.updateAIUserPreferences.mutationOptions());

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
        <div className="space-y-6">
            <div>
                <Heading className="text-2xl font-bold tracking-tight">{t`Agent Capabilities`}</Heading>
                <p className="text-muted-foreground">{t`Configure advanced AI agent modules for enhanced task execution`}</p>
            </div>

            <HeadingSection>
                <Alert>
                    <Info aria-hidden="true" className="h-4 w-4" />
                    <AlertDescription>
                        <Trans>
                            The agent loop is always enabled for systematic task execution. These settings control additional specialized modules that enhance
                            the AI&apos;s capabilities for specific task types.
                        </Trans>
                    </AlertDescription>
                </Alert>

                <Card>
                    <CardHeader>
                        <CardTitle>{t`Agent Modules`}</CardTitle>
                        <CardDescription>{t`Enable specialized modules to enhance AI capabilities`}</CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-6">
                        {/* Task Planning Module */}
                        <div className="flex items-start justify-between gap-4">
                            <div className="flex-1 space-y-1">
                                <Label className="text-base font-medium" htmlFor="enablePlanner">
                                    {t`Task Planning Module`}
                                </Label>
                                <p className="text-muted-foreground text-sm">
                                    {t`Break down complex tasks into numbered steps with progress tracking. Ideal for multi-step projects and development tasks.`}
                                </p>
                            </div>
                            <Switch
                                checked={aiPreferences?.enablePlanner ?? false}
                                disabled={updateAIUserPreferencesMutation.isPending}
                                id="enablePlanner"
                                onCheckedChange={(checked: boolean) => handleToggle("enablePlanner", checked)}
                            />
                        </div>

                        <Separator />

                        {/* Knowledge Module */}
                        <div className="flex items-start justify-between gap-4">
                            <div className="flex-1 space-y-1">
                                <Label className="text-base font-medium" htmlFor="enableKnowledge">
                                    {t`Knowledge Module`}
                                </Label>
                                <p className="text-muted-foreground text-sm">
                                    {t`Apply best practices, patterns, and domain-specific guidelines. Enhances responses with expert knowledge and proven approaches.`}
                                </p>
                            </div>
                            <Switch
                                checked={aiPreferences?.enableKnowledge ?? false}
                                disabled={updateAIUserPreferencesMutation.isPending}
                                id="enableKnowledge"
                                onCheckedChange={(checked: boolean) => handleToggle("enableKnowledge", checked)}
                            />
                        </div>

                        <Separator />

                        {/* Data Source Module */}
                        <div className="flex items-start justify-between gap-4">
                            <div className="flex-1 space-y-1">
                                <Label className="text-base font-medium" htmlFor="enableDatasource">
                                    {t`Data Source Module`}
                                </Label>
                                <p className="text-muted-foreground text-sm">
                                    {t`Validate data quality and prioritize authoritative sources. Essential for research tasks and fact-checking.`}
                                </p>
                            </div>
                            <Switch
                                checked={aiPreferences?.enableDatasource ?? false}
                                disabled={updateAIUserPreferencesMutation.isPending}
                                id="enableDatasource"
                                onCheckedChange={(checked: boolean) => handleToggle("enableDatasource", checked)}
                            />
                        </div>

                        <Separator />

                        {/* Auto Media Enrichment */}
                        <div className="flex items-start justify-between gap-4">
                            <div className="flex-1 space-y-1">
                                <Label className="text-base font-medium" htmlFor="autoMediaEnrichment">
                                    {t`Auto Media Enrichment`}
                                </Label>
                                <p className="text-muted-foreground text-sm">
                                    {t`Automatically include relevant images and videos alongside text responses when using search modes.`}
                                </p>
                            </div>
                            <Switch
                                checked={aiPreferences?.autoMediaEnrichment ?? false}
                                disabled={updateAIUserPreferencesMutation.isPending}
                                id="autoMediaEnrichment"
                                onCheckedChange={(checked: boolean) => handleToggle("autoMediaEnrichment", checked)}
                            />
                        </div>
                    </CardContent>
                </Card>

                <Card>
                    <CardHeader>
                        <CardTitle>{t`Automation`}</CardTitle>
                        <CardDescription>{t`Automatically enable modules based on task complexity`}</CardDescription>
                    </CardHeader>
                    <CardContent>
                        <div className="flex items-start justify-between gap-4">
                            <div className="flex-1 space-y-1">
                                <Label className="text-base font-medium" htmlFor="autoDetectComplexity">
                                    {t`Auto-Detect Task Complexity`}
                                </Label>
                                <p className="text-muted-foreground text-sm">
                                    <Trans>
                                        Automatically enable appropriate modules based on detected task type. Simplifies usage by intelligently activating
                                        features when needed.
                                    </Trans>
                                </p>
                            </div>
                            <Switch
                                checked={aiPreferences?.autoDetectComplexity ?? false}
                                disabled={updateAIUserPreferencesMutation.isPending}
                                id="autoDetectComplexity"
                                onCheckedChange={(checked: boolean) => handleToggle("autoDetectComplexity", checked)}
                            />
                        </div>
                    </CardContent>
                </Card>

                <Card>
                    <CardHeader>
                        <CardTitle>{t`Token Cost Impact`}</CardTitle>
                        <CardDescription>{t`Estimated token cost per conversation`}</CardDescription>
                    </CardHeader>
                    <CardContent className="text-muted-foreground text-sm">
                        <ul className="list-disc space-y-2 pl-5">
                            <li>{t`Base (agent loop only): ~2,300 tokens`}</li>
                            <li>{t`+ Task Planning: ~2,500 tokens (+200)`}</li>
                            <li>{t`+ Knowledge: ~2,600 tokens (+100)`}</li>
                            <li>{t`+ Data Source: ~2,700 tokens (+100)`}</li>
                        </ul>
                        <p className="mt-4 text-xs">
                            {t`Note: Modules are applied per conversation, not per message. Enable only the modules you need to optimize token usage.`}
                        </p>
                    </CardContent>
                </Card>
            </HeadingSection>
        </div>
    );
};

export default AgentSettings;
