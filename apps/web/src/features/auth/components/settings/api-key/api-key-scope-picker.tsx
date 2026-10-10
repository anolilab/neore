"use client";

import { useLingui } from "@lingui/react/macro";
import type { ApiAction, ApiResource } from "@neore/backend/public-api/scopes";
import { API_ACTIONS, API_RESOURCES } from "@neore/backend/public-api/scopes";
import { Button } from "@neore/ui/components/button";
import { Checkbox } from "@neore/ui/components/checkbox";
import { useId } from "react";

/** `threads:read`-style scope strings, the shape `createScopedApiKey` takes. */
export type ScopeSet = ReadonlySet<string>;

export const READ_ONLY_SCOPES: ScopeSet = new Set(API_RESOURCES.map((resource) => `${resource}:read`));

export const ALL_SCOPES: ScopeSet = new Set(API_RESOURCES.flatMap((resource) => API_ACTIONS.map((action) => `${resource}:${action}`)));

interface ApiKeyScopePickerProperties {
    onChange: (scopes: ScopeSet) => void;
    value: ScopeSet;
}

/** Resource × action grid of checkboxes. Write does not imply read — each is its own scope. */
const ApiKeyScopePicker = ({ onChange, value }: ApiKeyScopePickerProperties) => {
    const { t } = useLingui();
    const labelId = useId();

    const resourceLabels: Record<ApiResource, string> = {
        chat: t`Chat`,
        knowledge: t`Knowledge base`,
        memories: t`Memories`,
        models: t`Models`,
        skills: t`Skills`,
        tasks: t`Tasks`,
        threads: t`Threads`,
    };
    const actionLabels: Record<ApiAction, string> = { read: t`Read`, write: t`Write` };

    const toggle = (scope: string, checked: boolean) => {
        const next = new Set(value);

        if (checked) {
            next.add(scope);
        } else {
            next.delete(scope);
        }

        onChange(next);
    };

    return (
        <div aria-labelledby={labelId} className="space-y-2" role="group">
            <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium" id={labelId}>{t`Permissions`}</span>

                <div className="flex gap-1">
                    <Button
                        onClick={() => {
                            onChange(READ_ONLY_SCOPES);
                        }}
                        size="sm"
                        type="button"
                        variant="ghost"
                    >
                        {t`Read only`}
                    </Button>

                    <Button
                        onClick={() => {
                            onChange(ALL_SCOPES);
                        }}
                        size="sm"
                        type="button"
                        variant="ghost"
                    >
                        {t`Full access`}
                    </Button>
                </div>
            </div>

            <table className="w-full text-sm">
                <thead className="sr-only">
                    <tr>
                        <th scope="col">{t`Resource`}</th>

                        {API_ACTIONS.map((action) => (
                            <th key={action} scope="col">
                                {actionLabels[action]}
                            </th>
                        ))}
                    </tr>
                </thead>

                <tbody>
                    {API_RESOURCES.map((resource) => (
                        <tr className="border-border/50 border-b last:border-0" key={resource}>
                            <th className="py-1.5 text-start font-normal" scope="row">
                                {resourceLabels[resource]}
                            </th>

                            {API_ACTIONS.map((action) => {
                                const scope = `${resource}:${action}`;

                                return (
                                    <td className="w-20 py-1.5" key={action}>
                                        <div className="flex items-center gap-1.5">
                                            {/* Base UI's checkbox is not a native input, so a wrapping
                                                <label> would not name it; the name is set directly. */}
                                            <Checkbox
                                                aria-label={`${resourceLabels[resource]}: ${actionLabels[action]}`}
                                                checked={value.has(scope)}
                                                onCheckedChange={(checked) => {
                                                    toggle(scope, checked);
                                                }}
                                            />

                                            <span aria-hidden="true" className="text-muted-foreground text-xs">
                                                {actionLabels[action]}
                                            </span>
                                        </div>
                                    </td>
                                );
                            })}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
};

export default ApiKeyScopePicker;
