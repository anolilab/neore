"use client";

import { Trans, useLingui } from "@lingui/react/macro";
import type { Id } from "@neore/backend/dataModel";
import { Button } from "@neore/ui/components/button";
import { Checkbox } from "@neore/ui/components/checkbox";
import { Input } from "@neore/ui/components/input";
import { Label } from "@neore/ui/components/label";
import { Textarea } from "@neore/ui/components/textarea";
import { Store } from "lucide-react";
import type { ReactNode } from "react";
import { useId } from "react";

import { syncVariablesWithContent } from "@/features/prompts/lib/prompt-variables";

import type { BuilderAcceptance, BuilderDraft, BuilderRecommendations } from "../lib/skill-builder";
import { isConnectorActionable } from "../lib/skill-builder";
import { SKILL_DESCRIPTION_MAX, SKILL_NAME_MAX, SKILL_SLUG_MAX } from "../lib/skill-form";
import { ConnectorStatusBadge, useRecommendedConnectorStatuses } from "./skill-builder-connector-status";

interface ChoiceProps {
    checked: boolean;
    detail?: ReactNode;
    disabled?: boolean;
    label: ReactNode;
    onCheckedChange: (checked: boolean) => void;
    reason: string;
}

/** One accept/reject row: a checkbox labelled by the item and described by its one-line rationale. */
const Choice = ({ checked, detail, disabled, label, onCheckedChange, reason }: ChoiceProps) => {
    const id = useId();

    return (
        <div className="flex items-start gap-2">
            <Checkbox
                aria-describedby={`${id}-reason`}
                checked={checked && !disabled}
                disabled={disabled}
                id={id}
                onCheckedChange={(value) => onCheckedChange(value === true)}
            />
            <div className="grid gap-0.5 leading-snug">
                <Label className="cursor-pointer text-sm" htmlFor={id}>
                    {label}
                </Label>
                <span className="text-muted-foreground text-xs" id={`${id}-reason`}>
                    {reason}
                </span>
                {detail}
            </div>
        </div>
    );
};

const Section = ({ children, title }: { children: ReactNode; title: string }) => {
    const id = useId();

    return (
        <section aria-labelledby={id} className="space-y-3">
            <h3 className="text-sm font-medium" id={id}>
                {title}
            </h3>
            {children}
        </section>
    );
};

interface SkillBuilderReviewProps {
    acceptance: BuilderAcceptance;
    connectorLabels: Record<string, string>;
    draft: BuilderDraft;
    onAcceptanceChange: (next: BuilderAcceptance) => void;
    onDraftChange: (next: BuilderDraft) => void;
    onUseMarketplaceSkill: (skillId: Id<"skills">) => void;
    recommendations: BuilderRecommendations;
}

/**
 * The draft with every recommendation as an accept/reject choice. Editing a
 * field or ticking a box changes only local state — nothing is saved,
 * installed or enabled until the user saves the skill.
 */
const SkillBuilderReview = ({
    acceptance,
    connectorLabels,
    draft,
    onAcceptanceChange,
    onDraftChange,
    onUseMarketplaceSkill,
    recommendations,
}: SkillBuilderReviewProps) => {
    const { t } = useLingui();
    const id = useId();

    // Connected already, or impossible to connect here: nothing to set up after save.
    const connectorStatus = useRecommendedConnectorStatuses(recommendations.connectors.map((connector) => connector.id));

    const toggleIn = (key: "connectors" | "disableTools" | "enableTools" | "mcpServers", name: string, checked: boolean) =>
        onAcceptanceChange({ ...acceptance, [key]: { ...acceptance[key], [name]: checked } });

    const hasSettings = draft.preferredModel || draft.searchMode || draft.reasoningEffort || draft.enableTools.length > 0 || draft.disableTools.length > 0;
    const hasExternal = recommendations.mcpServers.length > 0 || recommendations.connectors.length > 0 || !recommendations.mcpRegistryAvailable;

    return (
        <div className="space-y-6">
            {recommendations.marketplaceSkills.length > 0 && (
                <Section title={t`Existing skills that may already fit`}>
                    <ul className="space-y-2">
                        {recommendations.marketplaceSkills.map(({ reason, skill }) => (
                            <li className="flex items-start justify-between gap-3 rounded-md border p-3" key={skill._id}>
                                <div className="grid gap-0.5">
                                    <span className="text-sm font-medium">{skill.name}</span>
                                    <span className="text-muted-foreground line-clamp-2 text-xs">{skill.description}</span>
                                    <span className="text-muted-foreground text-xs">{reason}</span>
                                </div>
                                <Button
                                    aria-label={t`Use ${skill.name} instead`}
                                    onClick={() => onUseMarketplaceSkill(skill._id)}
                                    size="sm"
                                    type="button"
                                    variant="outline"
                                >
                                    <Store aria-hidden="true" className="mr-1 size-4" />
                                    {t`Use this instead`}
                                </Button>
                            </li>
                        ))}
                    </ul>
                </Section>
            )}

            <Section title={t`Draft`}>
                <div className="grid gap-4 sm:grid-cols-2">
                    <div className="space-y-1">
                        <Label htmlFor={`${id}-name`}>{t`Name`}</Label>
                        <Input
                            id={`${id}-name`}
                            maxLength={SKILL_NAME_MAX}
                            onChange={(event) => onDraftChange({ ...draft, name: event.target.value })}
                            value={draft.name}
                        />
                    </div>
                    <div className="space-y-1">
                        <Label htmlFor={`${id}-slug`}>{t`Command`}</Label>
                        <Input
                            className="font-mono"
                            id={`${id}-slug`}
                            maxLength={SKILL_SLUG_MAX}
                            onChange={(event) => onDraftChange({ ...draft, slug: event.target.value.toLowerCase() })}
                            spellCheck={false}
                            value={draft.slug}
                        />
                    </div>
                </div>
                <div className="space-y-1">
                    <Label htmlFor={`${id}-description`}>{t`Description`}</Label>
                    <Input
                        id={`${id}-description`}
                        maxLength={SKILL_DESCRIPTION_MAX}
                        onChange={(event) => onDraftChange({ ...draft, description: event.target.value })}
                        value={draft.description}
                    />
                </div>
                <div className="space-y-1">
                    <Label htmlFor={`${id}-instructions`}>{t`Instructions`}</Label>
                    <Textarea
                        className="min-h-40 font-mono text-sm"
                        id={`${id}-instructions`}
                        onChange={(event) =>
                            onDraftChange({
                                ...draft,
                                instructions: event.target.value,
                                variables: syncVariablesWithContent(event.target.value, draft.variables),
                            })
                        }
                        value={draft.instructions}
                    />
                </div>
                {draft.variables.length > 0 && (
                    <p className="text-muted-foreground text-xs">
                        {t`Variables:`} <span className="font-mono">{draft.variables.map((variable) => `{{${variable.name}}}`).join(", ")}</span>
                    </p>
                )}
            </Section>

            {hasSettings && (
                <Section title={t`Recommended settings`}>
                    <div className="space-y-3">
                        {draft.preferredModel && (
                            <Choice
                                checked={acceptance.preferredModel}
                                label={t`Preferred model: ${draft.preferredModel.name}`}
                                onCheckedChange={(checked) => onAcceptanceChange({ ...acceptance, preferredModel: checked })}
                                reason={draft.preferredModel.reason}
                            />
                        )}
                        {draft.searchMode && (
                            <Choice
                                checked={acceptance.searchMode}
                                label={t`Search mode: ${draft.searchMode.id}`}
                                onCheckedChange={(checked) => onAcceptanceChange({ ...acceptance, searchMode: checked })}
                                reason={draft.searchMode.reason}
                            />
                        )}
                        {draft.reasoningEffort && (
                            <Choice
                                checked={acceptance.reasoningEffort}
                                label={t`Reasoning effort: ${draft.reasoningEffort.value} of 4`}
                                onCheckedChange={(checked) => onAcceptanceChange({ ...acceptance, reasoningEffort: checked })}
                                reason={draft.reasoningEffort.reason}
                            />
                        )}
                        {draft.enableTools.map((tool) => (
                            <Choice
                                checked={acceptance.enableTools[tool.name] ?? false}
                                key={`enable-${tool.name}`}
                                label={
                                    <>
                                        <Trans>
                                            Enable tool <span className="font-mono">{tool.name}</span>
                                        </Trans>
                                    </>
                                }
                                onCheckedChange={(checked) => toggleIn("enableTools", tool.name, checked)}
                                reason={tool.reason}
                            />
                        ))}
                        {draft.disableTools.map((tool) => (
                            <Choice
                                checked={acceptance.disableTools[tool.name] ?? false}
                                key={`disable-${tool.name}`}
                                label={
                                    <>
                                        <Trans>
                                            Disable tool <span className="font-mono">{tool.name}</span>
                                        </Trans>
                                    </>
                                }
                                onCheckedChange={(checked) => toggleIn("disableTools", tool.name, checked)}
                                reason={tool.reason}
                            />
                        ))}
                    </div>
                </Section>
            )}

            {hasExternal && (
                <Section title={t`Integrations`}>
                    <p className="text-muted-foreground text-xs">
                        {t`Checked integrations are offered for setup after you save. Nothing connects until you confirm it there.`}
                    </p>
                    {!recommendations.mcpRegistryAvailable && (
                        <p
                            className="text-muted-foreground text-xs"
                            role="status"
                        >{t`The MCP registry could not be reached, so server suggestions may be missing.`}</p>
                    )}
                    <div className="space-y-3">
                        {recommendations.mcpServers.map(({ reason, server }) => (
                            <Choice
                                checked={acceptance.mcpServers[server.id] ?? false}
                                detail={<span className="text-muted-foreground line-clamp-2 text-xs">{server.description}</span>}
                                key={server.id}
                                label={t`MCP server: ${server.title}`}
                                onCheckedChange={(checked) => toggleIn("mcpServers", server.id, checked)}
                                reason={reason}
                            />
                        ))}
                        {recommendations.connectors.map((connector) => (
                            <Choice
                                checked={acceptance.connectors[connector.id] ?? false}
                                detail={<ConnectorStatusBadge status={connectorStatus?.[connector.id]} />}
                                disabled={!isConnectorActionable(connectorStatus?.[connector.id])}
                                key={connector.id}
                                label={t`Connector: ${connectorLabels[connector.id] ?? connector.id}`}
                                onCheckedChange={(checked) => toggleIn("connectors", connector.id, checked)}
                                reason={connector.reason}
                            />
                        ))}
                    </div>
                </Section>
            )}
        </div>
    );
};

export default SkillBuilderReview;
