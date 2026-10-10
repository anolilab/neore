"use client";

import { useLingui } from "@lingui/react/macro";
import { api } from "@neore/backend/api";
import { Button } from "@neore/ui/components/button";
import { useAppForm } from "@neore/ui/components/form";
import { Input } from "@neore/ui/components/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@neore/ui/components/responsive-dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@neore/ui/components/select";
import cn from "@neore/ui/utils/cn";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import type { ComponentProps } from "react";
import { use, useMemo, useState } from "react";
import * as z from "zod";

import type { SettingsCardClassNames } from "@/components/settings/settings-card";
import { AuthQueryContext } from "@/features/auth/lib/auth-query-provider";
import { useAuth } from "@/features/auth/lib/auth-ui-provider";
import { DEFAULT_LOCALE } from "@/lib/intl/client";
import { useLunoraActionOptions } from "@/lib/lunora/crpc";

import type { Refetch } from "../../../types/hook-integration-types";
import type { ScopeSet } from "./api-key-scope-picker";
import ApiKeyScopePicker, { READ_ONLY_SCOPES } from "./api-key-scope-picker";

interface CreateAPIKeyDialogProperties extends ComponentProps<typeof Dialog> {
    classNames?: SettingsCardClassNames;
    onSuccess: (key: string) => void;
    refetch?: Refetch;
}

const CreateAPIKeyDialog = ({ classNames, onOpenChange, onSuccess, refetch, ...properties }: CreateAPIKeyDialogProperties) => {
    const { toast } = useAuth();
    const { i18n, t } = useLingui();
    const { listApiKeysKey } = use(AuthQueryContext);
    const queryClient = useQueryClient();
    const { mutateAsync: createScopedApiKey } = useMutation(useLunoraActionOptions(api.auth.api_keys.createScopedApiKey));
    const [scopes, setScopes] = useState<ScopeSet>(READ_ONLY_SCOPES);

    const formSchema = z.strictObject({
        expiresInDays: z.string(),
        name: z
            .string()
            .trim()
            .min(1, t`Name is required`)
            .max(32, t`Name must be at most 32 characters`),
    });

    const form = useAppForm({
        defaultValues: {
            expiresInDays: "none",
            name: "",
        },
        onSubmit: async ({ value }) => {
            if (scopes.size === 0) {
                toast({ message: t`Choose at least one permission`, variant: "error" });

                return;
            }

            try {
                // Minted server-side: `permissions` is a server-only field of
                // better-auth's create endpoint, so the plugin's client call
                // cannot set scopes (`auth/api-keys.ts`).
                const result = await createScopedApiKey({
                    expiresInDays: value.expiresInDays && value.expiresInDays !== "none" ? Number(value.expiresInDays) : null,
                    name: value.name,
                    scopes: [...scopes],
                });

                await queryClient.invalidateQueries({ queryKey: listApiKeysKey });
                await refetch?.();
                onSuccess(result.key);
                onOpenChange?.(false);
                form.reset();
                setScopes(READ_ONLY_SCOPES);
            } catch (error) {
                toast({
                    message: error instanceof Error && error.message ? error.message : t`Failed to create API key`,
                    variant: "error",
                });
            }
        },
        validators: {
            onChange: formSchema,
        },
    });

    const locale = i18n.locale ?? DEFAULT_LOCALE;
    const rtf = useMemo(() => new Intl.RelativeTimeFormat(locale), [locale]);

    return (
        <Dialog onOpenChange={onOpenChange} {...properties}>
            <DialogContent
                className={classNames?.dialog?.content}
                onOpenAutoFocus={(e) => {
                    e.preventDefault();
                }}
            >
                <DialogHeader className={classNames?.dialog?.header}>
                    <DialogTitle className={cn("text-lg md:text-xl", classNames?.title)}>{t`Create API Key`}</DialogTitle>

                    <DialogDescription className={cn("text-xs md:text-sm", classNames?.description)}>
                        {t`Create a new API key for programmatic access to your account`}
                    </DialogDescription>
                </DialogHeader>

                <form.AppForm>
                    <form
                        className="space-y-6"
                        onSubmit={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            form.handleSubmit();
                        }}
                    >
                        <div className="flex gap-4">
                            <form.AppField name="name">
                                {(field) => (
                                    <field.FormItem className="flex-1">
                                        <field.FormLabel className={classNames?.label} required>{t`Name`}</field.FormLabel>

                                        <field.FormControl>
                                            <Input
                                                autoFocus
                                                className={classNames?.input}
                                                maxLength={32}
                                                onBlur={field.handleBlur}
                                                onChange={(e) => {
                                                    field.handleChange(e.target.value);
                                                }}
                                                placeholder={t`Enter a name for your API key`}
                                                required
                                                value={field.state.value}
                                            />
                                        </field.FormControl>

                                        <field.FormMessage />
                                    </field.FormItem>
                                )}
                            </form.AppField>

                            <form.AppField name="expiresInDays">
                                {(field) => (
                                    <field.FormItem>
                                        <field.FormLabel className={classNames?.label}>{t`Expires`}</field.FormLabel>

                                        <Select onValueChange={(value) => field.handleChange(value ?? "")} value={field.state.value}>
                                            <field.FormControl>
                                                <SelectTrigger className={classNames?.input}>
                                                    <SelectValue placeholder={t`No expiration`} />
                                                </SelectTrigger>
                                            </field.FormControl>

                                            <SelectContent>
                                                <SelectItem value="none">{t`No expiration`}</SelectItem>

                                                <SelectItem value="7">{rtf.format(7, "day")}</SelectItem>

                                                <SelectItem value="30">{rtf.format(30, "day")}</SelectItem>

                                                <SelectItem value="90">{rtf.format(90, "day")}</SelectItem>

                                                <SelectItem value="180">{rtf.format(180, "day")}</SelectItem>

                                                <SelectItem value="365">{rtf.format(365, "day")}</SelectItem>
                                            </SelectContent>
                                        </Select>

                                        <field.FormMessage />
                                    </field.FormItem>
                                )}
                            </form.AppField>
                        </div>

                        <ApiKeyScopePicker onChange={setScopes} value={scopes} />

                        <DialogFooter className={classNames?.dialog?.footer}>
                            <form.Subscribe selector={(state) => ({ canSubmit: state.canSubmit, isSubmitting: state.isSubmitting }) as unknown as typeof state}>
                                {({ canSubmit, isSubmitting }) => (
                                    <Button className={classNames?.button} disabled={!canSubmit} type="submit">
                                        {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                                        {t`Create API Key`}
                                    </Button>
                                )}
                            </form.Subscribe>
                        </DialogFooter>
                    </form>
                </form.AppForm>
            </DialogContent>
        </Dialog>
    );
};

export default CreateAPIKeyDialog;
