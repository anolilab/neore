import { useLingui } from "@lingui/react/macro";
import type { Id } from "@neore/backend/dataModel";
import { Checkbox } from "@neore/ui/components/checkbox";
import { Label } from "@neore/ui/components/label";
import { RadioGroup, RadioGroupItem } from "@neore/ui/components/radio-group";
import { useMutation } from "@tanstack/react-query";
import type { FC } from "react";
import { useId } from "react";
import { toast } from "sonner";

import { useProjectList } from "@/features/projects/hooks/use-projects";
import { useCRPC } from "@/lib/lunora/crpc";

/**
 * Where one device's tools are offered: any chat, or only threads of the chosen projects. The server decides
 * (and re-checks at call time); this only edits the setting, which applies from the next turn.
 */
const DeviceScope: FC<{ deviceId: string; projectIds?: string[] }> = ({ deviceId, projectIds }) => {
    const { t } = useLingui();
    const crpc = useCRPC();
    const baseId = useId();
    const { projects } = useProjectList();
    const setScope = useMutation(crpc.devices.functions.setDeviceProjectScope.mutationOptions());
    const chat = projects.filter((project) => project.projectType !== "workflow");
    const chosen = new Set(projectIds);
    const scoped = projectIds !== undefined;

    const save = (scope: { kind: "any" } | { kind: "projects"; projectIds: Id<"projects">[] }): void => {
        setScope.mutate({ deviceId: deviceId as Id<"devices">, scope }, { onError: () => toast.error(t`Could not change where this device is offered.`) });
    };

    return (
        <div aria-labelledby={`${baseId}-label`} className="basis-full space-y-2" role="group">
            <Label id={`${baseId}-label`}>{t`Where this device is offered`}</Label>
            <RadioGroup
                aria-labelledby={`${baseId}-label`}
                disabled={setScope.isPending}
                onValueChange={(value) => {
                    if (value === "any") {
                        save({ kind: "any" });
                    } else if (!scoped) {
                        save({ kind: "projects", projectIds: [] });
                    }
                }}
                value={scoped ? "projects" : "any"}
            >
                <div className="flex items-center gap-2">
                    <RadioGroupItem id={`${baseId}-any`} value="any" />
                    <Label className="font-normal" htmlFor={`${baseId}-any`}>{t`Any of my chats`}</Label>
                </div>
                <div className="flex items-center gap-2">
                    <RadioGroupItem id={`${baseId}-projects`} value="projects" />
                    <Label className="font-normal" htmlFor={`${baseId}-projects`}>{t`Only these projects`}</Label>
                </div>
            </RadioGroup>
            {scoped && (
                <div className="space-y-2 pl-6">
                    {chat.length > 0 ? (
                        <ul aria-label={t`Projects this device is offered in`} className="space-y-1">
                            {chat.map((project) => (
                                <li className="flex items-center gap-2" key={project._id}>
                                    <Checkbox
                                        checked={chosen.has(project._id)}
                                        disabled={setScope.isPending}
                                        id={`${baseId}-${project._id}`}
                                        onCheckedChange={(checked) => {
                                            const next = new Set(chosen);

                                            if (checked) {
                                                next.add(project._id);
                                            } else {
                                                next.delete(project._id);
                                            }

                                            save({ kind: "projects", projectIds: [...next] as Id<"projects">[] });
                                        }}
                                    />
                                    <Label className="text-xs font-normal" htmlFor={`${baseId}-${project._id}`}>
                                        {project.title}
                                    </Label>
                                </li>
                            ))}
                        </ul>
                    ) : (
                        <p className="text-muted-foreground text-xs">{t`You have no projects yet.`}</p>
                    )}
                    <p className="text-muted-foreground text-xs" role="status">
                        {chosen.size === 0
                            ? t`Not offered in any chat until you choose a project.`
                            : t`Offered only in chats that belong to the projects above. It applies from the next message.`}
                    </p>
                </div>
            )}
        </div>
    );
};

export default DeviceScope;
