"use client";

import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import type { GatewayModel } from "@neore/ai/models";
import type { Id } from "@neore/backend/dataModel";
import { Alert, AlertDescription } from "@neore/ui/components/alert";
import { Button } from "@neore/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@neore/ui/components/card";
import { Heading } from "@neore/ui/components/heading";
import { Label } from "@neore/ui/components/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@neore/ui/components/select";
import { Textarea } from "@neore/ui/components/textarea";
import { ToggleGroup, ToggleGroupItem } from "@neore/ui/components/toggle-group";
import { useCallbackRef } from "@neore/ui/hooks/use-callback-ref";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Info } from "lucide-react";
import type { FC } from "react";
import { useEffect, useId, useRef, useState } from "react";

import { ReasoningEffortSelector } from "@/features/chat/model-settings/reasoning-effort-selector";
import { ModelSelect } from "@/features/settings/components/chat/default-models-settings";
import { offerableBackupModels } from "@/features/settings/lib/backup-model-options";
import useTaskProjects from "@/features/tasks/hooks/use-task-projects";
import useFeatureFlaggedModels from "@/hooks/use-feature-flagged-models";
import { useCRPC } from "@/lib/lunora/crpc";
import { showError } from "@/lib/toast";

/** Kept in step with `SUB_AGENT_ROLE_NAMES` in `backend/lunora/sub-agents/roles.ts`; the API types pin the names. */
const ROLE_NAMES = ["architecture", "implementation", "research", "review", "security", "design", "test", "general"] as const;

type RoleName = (typeof ROLE_NAMES)[number];

type Mode = "always" | "prefer";

interface RoleConfig {
    instructions?: string;
    mode?: Mode;
    model?: string;
    reasoningEffort?: number;
}

type Roles = Partial<Record<RoleName, RoleConfig>>;

const ROLE_LABELS: Record<RoleName, MessageDescriptor> = {
    architecture: msg`Architecture`,
    design: msg`Design`,
    general: msg`General`,
    implementation: msg`Implementation`,
    research: msg`Research`,
    review: msg`Review`,
    security: msg`Security`,
    test: msg`Testing`,
};

const ROLE_DESCRIPTIONS: Record<RoleName, MessageDescriptor> = {
    architecture: msg`Designing a system or a change that spans several parts.`,
    design: msg`Interface, user experience and visual design.`,
    general: msg`Any other self-contained task.`,
    implementation: msg`Writing or changing code, configuration or scripts.`,
    research: msg`Finding, reading and comparing sources.`,
    review: msg`Checking code, a draft or a plan for mistakes.`,
    security: msg`Vulnerabilities, secrets, access control, threat models.`,
    test: msg`Writing tests and checking that a change works.`,
};

/** How long the effort slider rests before its value is saved: one save per adjustment, not one per step. */
const EFFORT_SAVE_DELAY_MS = 400;

/** The value "everywhere" in the scope picker: the user's own roles. */
const ALL_CHATS = "all";

/** `config` without the empty fields, or `null` when nothing is left: the server stores no empty role. */
const compact = (config: RoleConfig): RoleConfig | null => {
    const entries = Object.entries(config).filter(([, value]) => value !== undefined);

    return entries.length > 0 ? (Object.fromEntries(entries) as RoleConfig) : null;
};

interface RoleCardProps {
    /** What the role is when this scope sets nothing: the user's own role in a project scope, nothing otherwise. */
    inherited?: RoleConfig;
    isProject: boolean;
    models: GatewayModel[];
    name: RoleName;
    /** Saves the whole role; answers whether the save went through. */
    onSave: (name: RoleName, config: RoleConfig | null) => Promise<boolean>;
    readOnly: boolean;
    value: RoleConfig | undefined;
}

const RoleCard: FC<RoleCardProps> = ({ inherited, isProject, models, name, onSave, readOnly, value }) => {
    const { i18n, t } = useLingui();
    const modeLabelId = useId();
    const instructionsId = useId();
    // The card's own copy of the role: every save sends the whole role, so it is built from the edits made here, not
    // from a server copy that may not have caught up with the previous save yet.
    const [own, setOwnState] = useState<RoleConfig>(value ?? {});
    const ownRef = useRef(own);
    const serverValue = useRef(value);
    const inFlight = useRef(0);
    const saveChain = useRef<Promise<void>>(Promise.resolve());
    const effortTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const effectiveModelId = own.model ?? inherited?.model;
    const effectiveModel = models.find((model) => model.id === effectiveModelId);
    const effectiveMode = own.mode ?? inherited?.mode ?? "prefer";
    const [draft, setDraft] = useState(own.instructions ?? "");
    const roleLabel = i18n._(ROLE_LABELS[name]);
    const disabled = readOnly;

    const setOwn = (next: RoleConfig) => {
        const kept = compact(next) ?? {};

        ownRef.current = kept;
        setOwnState(kept);
    };

    // The server's copy replaces the card's only once nothing the card sent is still on its way.
    useEffect(() => {
        serverValue.current = value;

        if (inFlight.current === 0 && effortTimer.current === undefined) {
            ownRef.current = value ?? {};
            setOwnState(value ?? {});
        }
    }, [value]);

    // One save at a time, each sending the role as it is when its turn comes, so they reach the server in order.
    const send = useCallbackRef(() => {
        const runSave = async () => {
            const saved = await onSave(name, compact(ownRef.current));

            inFlight.current -= 1;

            // A refused save leaves the card showing what the server has.
            if (!saved && inFlight.current === 0) {
                ownRef.current = serverValue.current ?? {};
                setOwnState(serverValue.current ?? {});
            }
        };

        inFlight.current += 1;
        saveChain.current = saveChain.current.then(runSave);
    });

    const save = (patch: Partial<RoleConfig>) => {
        setOwn({ ...ownRef.current, ...patch });
        send();
    };

    const flushEffort = useCallbackRef(() => {
        if (effortTimer.current === undefined) {
            return;
        }

        clearTimeout(effortTimer.current);
        effortTimer.current = undefined;
        send();
    });

    // Leaving the card (another scope, the settings closed) still saves an effort the slider was just moved to.
    useEffect(() => flushEffort, [flushEffort]);

    const changeEffort = (reasoningEffort: number | undefined) => {
        setOwn({ ...ownRef.current, reasoningEffort });
        clearTimeout(effortTimer.current);
        effortTimer.current = setTimeout(flushEffort, EFFORT_SAVE_DELAY_MS);
    };

    const inheritedModelName = inherited?.model ? (models.find((model) => model.id === inherited.model)?.name ?? inherited.model) : undefined;
    const inheritLabel = inheritedModelName ? t`Your default (${inheritedModelName})` : t`Your default (off)`;
    let rolePlaceholder = t`Added after the built-in instructions for this role, e.g. "Check every change against our style guide."`;

    if (isProject && own.instructions === "") {
        rolePlaceholder = t`No extra instructions in this project. Reset to use your default again.`;
    } else if (isProject && inherited?.instructions) {
        rolePlaceholder = inherited.instructions;
    }

    return (
        <Card>
            <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
                <div className="space-y-1">
                    <CardTitle className="text-base">{roleLabel}</CardTitle>
                    <CardDescription>{i18n._(ROLE_DESCRIPTIONS[name])}</CardDescription>
                </div>
                {isProject && Object.keys(own).length > 0 && !readOnly && (
                    <Button
                        aria-label={t`Reset ${roleLabel} to your default`}
                        onClick={() => {
                            clearTimeout(effortTimer.current);
                            effortTimer.current = undefined;
                            setDraft("");
                            setOwn({});
                            send();
                        }}
                        size="sm"
                        variant="ghost"
                    >
                        {t`Reset`}
                    </Button>
                )}
            </CardHeader>
            <CardContent className="space-y-4">
                <ModelSelect
                    description={effectiveModelId ? t`Delegated ${roleLabel.toLowerCase()} work runs on this model.` : t`Off until you pick a model.`}
                    disabled={disabled}
                    emptyLabel={isProject ? inheritLabel : t`Off`}
                    field={name}
                    label={t`Model`}
                    models={models}
                    onChange={(_field, modelId) => save({ model: modelId ?? undefined })}
                    value={own.model}
                />

                {effectiveModelId && (
                    <div className="flex items-start justify-between gap-4">
                        <div className="min-w-0 flex-1 space-y-0.5">
                            <Label className="text-sm font-medium" id={modeLabelId}>
                                {t`When to delegate`}
                            </Label>
                            <p className="text-muted-foreground text-xs">
                                {effectiveMode === "always"
                                    ? t`All real ${roleLabel.toLowerCase()} work goes to this model, even quick work.`
                                    : t`Bigger pieces go to this model; quick questions stay in the chat.`}
                            </p>
                        </div>
                        <ToggleGroup
                            aria-labelledby={modeLabelId}
                            disabled={disabled}
                            onValueChange={(next) => {
                                const mode = next?.[0];

                                if (mode === "prefer" || mode === "always") {
                                    save({ mode });
                                }
                            }}
                            size="sm"
                            value={[effectiveMode]}
                            variant="outline"
                        >
                            <ToggleGroupItem value="prefer">{t`Prefer`}</ToggleGroupItem>
                            <ToggleGroupItem value="always">{t`Always`}</ToggleGroupItem>
                        </ToggleGroup>
                    </div>
                )}

                {effectiveModel && !readOnly && (
                    <ReasoningEffortSelector model={effectiveModel} onChange={changeEffort} value={own.reasoningEffort ?? inherited?.reasoningEffort} />
                )}

                <div className="space-y-1.5">
                    <Label className="text-sm font-medium" htmlFor={instructionsId}>
                        {t`Extra instructions`}
                    </Label>
                    <Textarea
                        disabled={disabled}
                        id={instructionsId}
                        maxLength={4000}
                        onBlur={() => {
                            if (draft !== (own.instructions ?? "")) {
                                save({ instructions: draft.length > 0 ? draft : undefined });
                            }
                        }}
                        onChange={(event) => setDraft(event.target.value)}
                        placeholder={rolePlaceholder}
                        rows={3}
                        spellCheck
                        value={draft}
                    />
                    {isProject && inherited?.instructions && own.instructions === undefined && !readOnly && (
                        <Button className="h-auto px-0" onClick={() => save({ instructions: "" })} size="sm" variant="link">
                            {t`Don't use your default instructions in this project`}
                        </Button>
                    )}
                </div>
            </CardContent>
        </Card>
    );
};

const SubAgentRolesSettings: FC = () => {
    const { t } = useLingui();
    const crpc = useCRPC();
    const scopeLabelId = useId();
    const [scope, setScope] = useState<string>(ALL_CHATS);
    const projectId = scope === ALL_CHATS ? undefined : (scope as Id<"projects">);
    // Every project the user can read, a page at a time: their own and their organization's.
    const projectList = useTaskProjects("");
    const rolesQuery = useQuery(crpc.sub_agents.role_settings.getSubAgentRoles.queryOptions(projectId ? { projectId } : {}));
    // Offline, a save still goes to the Lunora client, which queues it for the reconnect; TanStack would hold it back
    // in memory instead, where closing the tab loses it.
    const setUserRole = useMutation({ ...crpc.auth.functions.setSubAgentRole.mutationOptions(), networkMode: "always" });
    const setProjectRole = useMutation({ ...crpc.projects.functions.setProjectSubAgentRole.mutationOptions(), networkMode: "always" });
    const flaggedModels = useFeatureFlaggedModels();
    const { data: access } = useQuery(crpc.auth.functions.getPaidModelAccess.queryOptions({}, { live: false }));
    const { data: aiPreferences } = useQuery(crpc.auth.functions.getAIUserPreferences.queryOptions({}));
    const providersWithKey = new Set(
        Object.entries((aiPreferences?.providerApiKeys ?? {}) as Record<string, { enabled?: boolean; hasKey?: boolean }>)
            .filter(([, entry]) => entry.enabled && entry.hasKey)
            .map(([provider]) => provider),
    );
    // The save re-checks on the server (model filters included); this keeps the list to chat models a run could use.
    const models = offerableBackupModels(
        flaggedModels.filter((model) => model.enabled && (model.mode === "text" || !model.mode)),
        access?.canRunPaidModels === true,
        providersWithKey,
    );
    const projects = projectList.readableProjects.filter((project) => project.projectType !== "workflow");
    const user: Roles = rolesQuery.data?.user ?? {};
    const project = rolesQuery.data?.project;
    const handleSave = async (name: RoleName, config: RoleConfig | null): Promise<boolean> => {
        const saving = projectId ? setProjectRole.mutateAsync({ config, projectId, role: name }) : setUserRole.mutateAsync({ config, role: name });

        return await saving
            .then(() => true)
            .catch((error: unknown) => {
                showError(error instanceof Error ? error : t`Could not save the role`);

                return false;
            });
    };

    return (
        <div className="space-y-6">
            <div>
                <Heading className="text-2xl font-bold tracking-tight">{t`Sub-agent roles`}</Heading>
                <p className="text-muted-foreground">
                    {t`Choose a model for each kind of work the assistant hands to a sub-agent. A role with a model is offered to the assistant; one without stays off.`}
                </p>
            </div>

            <Alert>
                <Info aria-hidden="true" className="h-4 w-4" />
                <AlertDescription>
                    {t`"Always" is guidance to the assistant, not a hard rule. Ask it to do something itself and it will. Chats keep the model you picked for them; only sub-agents use these models.`}
                </AlertDescription>
            </Alert>

            <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 flex-1 space-y-0.5">
                    <Label className="text-sm font-medium" id={scopeLabelId}>
                        {t`Applies to`}
                    </Label>
                    <p className="text-muted-foreground text-xs">
                        {projectId ? t`This project's chats. Anything it does not set uses your default.` : t`Every chat, unless its project sets the role.`}
                    </p>
                </div>
                <Select<string> onValueChange={(next) => setScope(next ?? ALL_CHATS)} value={scope}>
                    <SelectTrigger aria-labelledby={scopeLabelId} className="w-56 shrink-0">
                        <SelectValue>{projectId ? (projects.find((item) => item._id === projectId)?.title ?? t`Project`) : t`All chats`}</SelectValue>
                    </SelectTrigger>
                    <SelectContent align="end" className="max-h-64">
                        <SelectItem value={ALL_CHATS}>{t`All chats`}</SelectItem>
                        {projects.map((item) => (
                            <SelectItem key={item._id} value={item._id}>
                                {item.title}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            </div>

            {projectList.hasMore && (
                <div className="flex justify-end">
                    <Button disabled={projectList.isLoadingMore} onClick={projectList.loadMore} size="sm" variant="ghost">
                        {projectList.isLoadingMore ? t`Loading projects…` : t`Show more projects`}
                    </Button>
                </div>
            )}

            {project && !project.editable && (
                <p className="text-muted-foreground text-sm" role="status">
                    {t`Only the project's owner can change its roles.`}
                </p>
            )}

            {rolesQuery.isPending ? (
                <p className="text-muted-foreground text-sm" role="status">
                    {t`Loading roles…`}
                </p>
            ) : (
                <div className="space-y-4">
                    {ROLE_NAMES.map((name) => (
                        <RoleCard
                            inherited={projectId ? user[name] : undefined}
                            isProject={projectId !== undefined}
                            // A new scope starts its instruction draft from what that scope stores.
                            key={`${scope}:${name}`}
                            models={models}
                            name={name}
                            onSave={handleSave}
                            readOnly={project ? !project.editable : false}
                            value={projectId ? project?.roles[name] : user[name]}
                        />
                    ))}
                </div>
            )}
        </div>
    );
};

export default SubAgentRolesSettings;
