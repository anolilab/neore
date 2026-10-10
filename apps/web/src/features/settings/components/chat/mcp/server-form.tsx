import { Plural, useLingui } from "@lingui/react/macro";
import { Avatar, AvatarFallback, AvatarImage } from "@neore/ui/components/avatar";
import { Button } from "@neore/ui/components/button";
import { Heading } from "@neore/ui/components/heading";
import { Input } from "@neore/ui/components/input";
import { Label } from "@neore/ui/components/label";
import { Switch } from "@neore/ui/components/switch";
import { AlertTriangle, CheckCircle2, KeyRound, Loader2, PlugZap, Plus, Trash2, X } from "lucide-react";
import type { Dispatch, FC, SetStateAction } from "react";
import { useCallback, useId } from "react";

import { getServerInitials } from "@/features/chat/core/utils/mcp";

import type { MCPServerFormData, MCPSetupField, ServerStatusInfo } from "./types";
import { applySetupValue } from "./utilities";

const SELECT_CLASS = "border-input bg-background flex h-9 w-full rounded-md border px-3 py-1 text-sm";

/** One registry-described value: a URL variable or a header credential. */
const SetupFieldInput: FC<{ field: MCPSetupField; idPrefix: string; onChange: (key: string, value: string) => void; value: string }> = ({
    field,
    idPrefix,
    onChange,
    value,
}) => {
    const { t } = useLingui();
    const id = `${idPrefix}-${field.key.replaceAll(/[^\w-]/g, "_")}`;
    const descriptionId = field.description ? `${id}-description` : undefined;

    return (
        <div className="space-y-1.5">
            <Label className="text-xs" htmlFor={id}>
                <span className="font-mono">{field.label}</span>
                {field.isRequired ? <span className="text-destructive">{t`(required)`}</span> : <span className="text-muted-foreground">{t`(optional)`}</span>}
            </Label>
            {field.choices && field.choices.length > 0 ? (
                <select aria-describedby={descriptionId} className={SELECT_CLASS} id={id} onChange={(e) => onChange(field.key, e.target.value)} value={value}>
                    {field.choices.map((choice) => (
                        <option key={choice} value={choice}>
                            {choice}
                        </option>
                    ))}
                </select>
            ) : (
                <Input
                    aria-describedby={descriptionId}
                    aria-required={field.isRequired}
                    autoComplete="off"
                    id={id}
                    onChange={(e) => onChange(field.key, e.target.value)}
                    type={field.isSecret ? "password" : "text"}
                    value={value}
                />
            )}
            {field.description && (
                <p className="text-muted-foreground text-xs" id={descriptionId}>
                    {field.description}
                </p>
            )}
        </div>
    );
};

/** Inline result of the last connection test for the server being edited. */
const TestResult: FC<{ info: ServerStatusInfo | undefined }> = ({ info }) => {
    const { t } = useLingui();

    if (info?.status === "connected") {
        return (
            <div className="flex items-start gap-2 rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-xs text-green-800 dark:border-green-800 dark:bg-green-950/50 dark:text-green-300">
                <CheckCircle2 aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
                <div>
                    <p className="font-medium">
                        {t`Connection successful`} &mdash; <Plural one="# tool found" other="# tools found" value={info.tools.length} />
                        {info.latencyMs != null && <span className="text-green-600 dark:text-green-400"> ({info.latencyMs}ms)</span>}
                    </p>
                    {info.tools.length > 0 && (
                        <div className="mt-1 flex flex-wrap gap-1">
                            {info.tools.map((tool) => (
                                <span
                                    className="inline-flex rounded-full bg-green-100 px-2 py-0.5 text-[10px] font-medium text-green-700 dark:bg-green-900/50 dark:text-green-300"
                                    key={tool}
                                >
                                    {tool}
                                </span>
                            ))}
                        </div>
                    )}
                </div>
            </div>
        );
    }

    if (info?.status === "error") {
        return (
            <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800 dark:border-red-800 dark:bg-red-950/50 dark:text-red-300">
                <AlertTriangle aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
                <p>{info.error || t`Connection failed`}</p>
            </div>
        );
    }

    return null;
};

export interface MCPServerFormProps {
    formData: MCPServerFormData;
    isEditing: boolean;
    isTesting: boolean;
    onCancel: () => void;
    onSave: () => void;
    onTest: () => void;
    setFormData: Dispatch<SetStateAction<MCPServerFormData>>;
    testResult: ServerStatusInfo | undefined;
}

export const MCPServerForm: FC<MCPServerFormProps> = ({ formData, isEditing, isTesting, onCancel, onSave, onTest, setFormData, testResult }) => {
    const { t } = useLingui();
    const setupIdPrefix = useId();

    const handleAddHeader = useCallback(() => {
        setFormData((previous) => {
            return {
                ...previous,
                headers: [...previous.headers, { key: "", value: "" }],
            };
        });
    }, [setFormData]);

    const handleRemoveHeader = useCallback(
        (index: number) => {
            setFormData((previous) => {
                return {
                    ...previous,
                    headers: previous.headers.filter((_, i) => i !== index),
                };
            });
        },
        [setFormData],
    );

    const handleUpdateHeader = useCallback(
        (index: number, field: "key" | "value", value: string) => {
            setFormData((previous) => {
                return {
                    ...previous,
                    headers: previous.headers.map((h, i) => (i === index ? { ...h, [field]: value } : h)),
                };
            });
        },
        [setFormData],
    );

    const handleSetupChange = useCallback(
        (key: string, value: string) => {
            setFormData((previous) => applySetupValue(previous, key, value));
        },
        [setFormData],
    );

    return (
        <div className="space-y-4 rounded-lg border p-4">
            <div className="flex items-center justify-between">
                <Heading className="text-sm font-medium" fallbackLevel={4}>
                    {isEditing ? t`Edit MCP Server` : t`Add MCP Server`}
                </Heading>
                <Button aria-label={t`Close`} onClick={onCancel} size="sm" variant="ghost">
                    <X aria-hidden="true" className="size-4" />
                </Button>
            </div>

            {formData.setup && (
                <fieldset className="space-y-3 rounded-lg border border-dashed p-3">
                    <legend className="flex items-center gap-1.5 px-1 text-xs font-medium">
                        <KeyRound aria-hidden="true" className="size-3.5" />
                        {t`Server configuration`}
                    </legend>
                    <p className="text-muted-foreground text-xs">{t`This server's registry entry asks for the values below. They fill in the URL and headers.`}</p>
                    {formData.setup.fields.map((field) => (
                        <SetupFieldInput
                            field={field}
                            idPrefix={setupIdPrefix}
                            key={field.key}
                            onChange={handleSetupChange}
                            value={formData.setup?.values[field.key] ?? ""}
                        />
                    ))}
                </fieldset>
            )}

            <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                    <Label className="text-xs" htmlFor="mcp-name">
                        {t`Name`}
                    </Label>
                    <Input
                        id="mcp-name"
                        onChange={(e) =>
                            setFormData((previous) => {
                                return { ...previous, name: e.target.value };
                            })
                        }
                        placeholder={t`My MCP Server`}
                        value={formData.name}
                    />
                </div>
                <div className="space-y-2">
                    <Label className="text-xs" htmlFor="mcp-protocol">
                        {t`Protocol`}
                    </Label>
                    <select
                        className={SELECT_CLASS}
                        id="mcp-protocol"
                        onChange={(e) =>
                            setFormData((previous) => {
                                return { ...previous, protocol: e.target.value as "sse" | "http" };
                            })
                        }
                        value={formData.protocol}
                    >
                        <option value="http">{t`Streamable HTTP (Recommended)`}</option>
                        <option value="sse">{t`Server-Sent Events (SSE)`}</option>
                    </select>
                </div>
            </div>

            <div className="space-y-2">
                <Label className="text-xs" htmlFor="mcp-url">
                    {t`URL`}
                </Label>
                <Input
                    id="mcp-url"
                    onChange={(e) =>
                        setFormData((previous) => {
                            return { ...previous, url: e.target.value };
                        })
                    }
                    placeholder="https://your-server.com/mcp"
                    value={formData.url}
                />
            </div>

            <div className="space-y-2">
                <Label className="text-xs" htmlFor="mcp-icon">
                    {t`Icon URL (Optional)`}
                </Label>
                <div className="flex items-center gap-2">
                    <Input
                        className="flex-1"
                        id="mcp-icon"
                        onChange={(e) =>
                            setFormData((previous) => {
                                return { ...previous, icon: e.target.value };
                            })
                        }
                        placeholder="https://example.com/icon.png"
                        value={formData.icon}
                    />
                    {formData.icon ? (
                        <Avatar className="size-7 shrink-0" size="sm">
                            <AvatarImage src={formData.icon} />
                            <AvatarFallback>{getServerInitials(formData.name || "MCP")}</AvatarFallback>
                        </Avatar>
                    ) : (
                        formData.name && (
                            <Avatar className="size-7 shrink-0" size="sm">
                                <AvatarFallback>{getServerInitials(formData.name)}</AvatarFallback>
                            </Avatar>
                        )
                    )}
                </div>
            </div>

            {/* Headers */}
            <div className="space-y-2">
                <div className="flex items-center justify-between">
                    <Label className="text-xs">{t`Headers (Optional)`}</Label>
                    <Button className="h-7 text-xs" onClick={handleAddHeader} size="sm" variant="ghost">
                        <Plus aria-hidden="true" className="mr-1 size-3" />
                        {t`Add Header`}
                    </Button>
                </div>
                {formData.headers.map((header, index) => (
                    <div className="flex items-center gap-2" key={`header-${header.key || index}`}>
                        <Input
                            aria-label={t`Header name`}
                            className="flex-1"
                            onChange={(e) => handleUpdateHeader(index, "key", e.target.value)}
                            placeholder={t`Header name`}
                            value={header.key}
                        />
                        <Input
                            aria-label={t`Header value`}
                            className="flex-1"
                            onChange={(e) => handleUpdateHeader(index, "value", e.target.value)}
                            placeholder={t`Header value`}
                            type="password"
                            value={header.value}
                        />
                        <Button aria-label={t`Remove header`} className="shrink-0" onClick={() => handleRemoveHeader(index)} size="sm" variant="ghost">
                            <Trash2 aria-hidden="true" className="size-4" />
                        </Button>
                    </div>
                ))}
            </div>

            <div className="flex items-center gap-2">
                <Switch
                    checked={formData.enabled}
                    id="mcp-server-enabled"
                    onCheckedChange={(checked) =>
                        setFormData((previous) => {
                            return { ...previous, enabled: checked };
                        })
                    }
                />
                <Label className="text-xs" htmlFor="mcp-server-enabled">{t`Enabled`}</Label>
            </div>

            <div aria-live="polite">
                <TestResult info={testResult} />
            </div>

            <div className="flex justify-end gap-2">
                <Button disabled={isTesting} onClick={onTest} size="sm" variant="outline">
                    {isTesting ? (
                        <Loader2 aria-hidden="true" className="mr-2 size-3.5 animate-spin" />
                    ) : (
                        <PlugZap aria-hidden="true" className="mr-2 size-3.5" />
                    )}
                    {t`Test Connection`}
                </Button>
                <Button onClick={onCancel} size="sm" variant="outline">
                    {t`Cancel`}
                </Button>
                <Button onClick={onSave} size="sm">
                    {isEditing ? t`Update Server` : t`Add Server`}
                </Button>
            </div>
        </div>
    );
};
