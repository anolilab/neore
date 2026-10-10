"use client";

import { useLingui } from "@lingui/react/macro";
import { Badge } from "@neore/ui/components/badge";
import { Button } from "@neore/ui/components/button";
import { CardContent } from "@neore/ui/components/card";
import { useAppForm } from "@neore/ui/components/form";
import { Input } from "@neore/ui/components/input";
import { Label } from "@neore/ui/components/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@neore/ui/components/select";
import { Skeleton } from "@neore/ui/components/skeleton";
import cn from "@neore/ui/utils/cn";
import { skipToken, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { useCallback, useState } from "react";
import * as z from "zod";

import type { SettingsCardProperties } from "@/components/settings/settings-card";
import SettingsCard from "@/components/settings/settings-card";
import { useActiveOrganization, useHasPermission } from "@/features/auth/hooks/organization-management";
import { useAuth } from "@/features/auth/lib/auth-ui-provider";
import useCheckout from "@/features/billing/hooks/use-checkout";
import { useCRPC } from "@/lib/lunora/crpc";

import { getLocalizedError } from "../../lib/utilities";

// Common AI models
const AVAILABLE_MODELS = [
    "gemini-1.5-flash",
    "gemini-1.5-pro",
    "gemini-2.0-flash",
    "claude-3-haiku-20240307",
    "claude-3-5-sonnet-20241022",
    "claude-3-opus-20240229",
    "gpt-4o-mini",
    "gpt-4o",
    "gpt-4-turbo",
];

const BillingSettingsForm = ({ className, classNames, ...properties }: SettingsCardProperties) => {
    const { authClient, toast } = useAuth();
    const { t } = useLingui();
    const crpc = useCRPC();
    const queryClient = useQueryClient();

    const { data: hasPermission, isPending: isPermissionPending } = useHasPermission(authClient, {
        permissions: {
            organization: ["update"],
        },
    });

    const isOwner = hasPermission?.success;

    const { data: billingInfo, isPending: isBillingPending } = useQuery(crpc.auth.billing.getBillingInfo.queryOptions(isOwner ? {} : skipToken));

    const updateBillingMutation = useMutation(crpc.auth.billing.updateBillingSettings.mutationOptions());
    const { isPending: checkoutPending, openPortal, startCheckout } = useCheckout();

    const [selectedModels, setSelectedModels] = useState<string[]>(billingInfo?.allowedModels ?? []);
    const selectedModelSet = new Set(selectedModels);

    // Update selected models when billing info loads
    useState(() => {
        if (billingInfo?.allowedModels) {
            setSelectedModels(billingInfo.allowedModels);
        }
    });

    // The tier follows the Creem subscription (or a platform admin), so the owner
    // form only edits contact e-mail and models.
    const formSchema = z.object({
        billingEmail: z.email().optional().or(z.literal("")),
    });

    const form = useAppForm({
        defaultValues: {
            billingEmail: billingInfo?.billingEmail ?? "",
        },
        onSubmit: async ({ value }) => {
            try {
                await updateBillingMutation.mutateAsync({
                    allowedModels: selectedModels.length > 0 ? selectedModels : undefined,
                    billingEmail: value.billingEmail || undefined,
                });

                await queryClient.invalidateQueries({ queryKey: ["auth", "billing"] });

                toast({
                    message: t`Billing settings updated successfully`,
                    variant: "success",
                });
            } catch (error) {
                toast({
                    message: getLocalizedError({ error, t }),
                    variant: "error",
                });
            }
        },
        validators: {
            onChange: ({ value }) => {
                const result = formSchema.safeParse(value);

                if (!result.success) {
                    return result.error.issues[0]?.message;
                }

                return undefined;
            },
        },
    });

    const handleAddModel = useCallback((model: string) => {
        setSelectedModels((previous) => {
            if (previous.includes(model)) {
                return previous;
            }

            return [...previous, model];
        });
    }, []);

    const handleRemoveModel = useCallback((model: string) => {
        setSelectedModels((previous) => previous.filter((m) => m !== model));
    }, []);

    const { isSubmitting } = form.state;
    const isPending = isPermissionPending || isBillingPending;

    if (!isOwner && !isPending) {
        return (
            <SettingsCard
                className={className}
                classNames={classNames}
                description={t`Only organization owners can manage billing settings`}
                title={t`Billing Settings`}
                {...properties}
            >
                <CardContent className={cn("space-y-4", classNames?.content)}>
                    <div className="text-muted-foreground text-sm">
                        {t`Current tier:`} <strong>{billingInfo?.baseTier ?? "free"}</strong>
                    </div>
                    <div className="text-muted-foreground text-sm">
                        {t`Credits per user:`} <strong>{billingInfo?.creditsPerUser ?? 100}</strong>
                    </div>
                </CardContent>
            </SettingsCard>
        );
    }

    return (
        <form.AppForm>
            <form
                onSubmit={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    form.handleSubmit();
                }}
            >
                <SettingsCard
                    actionLabel={t`Save`}
                    className={className}
                    classNames={classNames}
                    description={t`Configure the billing contact and available AI models`}
                    disabled={!isOwner}
                    isPending={isPending}
                    title={t`Billing Settings`}
                    {...properties}
                >
                    <CardContent className={cn("space-y-4", classNames?.content)}>
                        {isPending ? (
                            <>
                                <Skeleton className={cn("h-9 w-full", classNames?.skeleton)} />
                                <Skeleton className={cn("h-9 w-full", classNames?.skeleton)} />
                                <Skeleton className={cn("h-20 w-full", classNames?.skeleton)} />
                            </>
                        ) : (
                            <>
                                {/* Tier and credits: read-only, managed by the platform's billing system */}
                                <div className="text-muted-foreground space-y-1 text-sm">
                                    <div>
                                        {t`Current tier:`} <strong>{billingInfo?.baseTier ?? "free"}</strong>
                                    </div>
                                    <div>
                                        {t`Credits per user:`} <strong>{billingInfo?.creditsPerUser ?? 100}</strong>
                                    </div>
                                    <p className="text-xs">{t`Your plan and credit allowance follow your subscription.`}</p>
                                    {billingInfo?.creemSubscriptionId ? (
                                        <Button
                                            disabled={checkoutPending}
                                            onClick={() => {
                                                void openPortal("organization");
                                            }}
                                            size="sm"
                                            type="button"
                                            variant="outline"
                                        >
                                            {t`Manage Team subscription`}
                                        </Button>
                                    ) : (
                                        <Button
                                            disabled={checkoutPending}
                                            onClick={() => {
                                                void startCheckout("team");
                                            }}
                                            size="sm"
                                            type="button"
                                        >
                                            {t`Upgrade organization to Team`}
                                        </Button>
                                    )}
                                </div>

                                {/* Billing Email */}
                                <form.AppField name="billingEmail">
                                    {(field) => (
                                        <field.FormItem>
                                            <Label>{t`Billing Email`}</Label>
                                            <field.FormControl>
                                                <Input
                                                    className={classNames?.input}
                                                    disabled={isSubmitting || !isOwner}
                                                    onBlur={field.handleBlur}
                                                    onChange={(e) => field.handleChange(e.target.value)}
                                                    placeholder={t`Enter billing email`}
                                                    type="email"
                                                    value={field.state.value}
                                                />
                                            </field.FormControl>
                                            <field.FormMessage className={classNames?.error} />
                                        </field.FormItem>
                                    )}
                                </form.AppField>

                                {/* Allowed Models */}
                                <div className="space-y-2">
                                    <Label>{t`Allowed AI Models`}</Label>
                                    <p className="text-muted-foreground text-xs">
                                        {t`Select which AI models organization members can use. Leave empty for enterprise to allow all models.`}
                                    </p>
                                    <div className="flex flex-wrap gap-2">
                                        {selectedModels.map((model) => (
                                            <Badge className="gap-1" key={model} variant="secondary">
                                                {model}
                                                <button
                                                    aria-label={t`Remove ${model}`}
                                                    className="hover:bg-muted ml-1 rounded-full p-0.5"
                                                    disabled={isSubmitting || !isOwner}
                                                    onClick={() => handleRemoveModel(model)}
                                                    type="button"
                                                >
                                                    <X aria-hidden="true" className="h-3 w-3" />
                                                </button>
                                            </Badge>
                                        ))}
                                    </div>
                                    <Select
                                        disabled={isSubmitting || !isOwner}
                                        onValueChange={(value) => {
                                            if (value) {
                                                handleAddModel(value);
                                            }
                                        }}
                                        value=""
                                    >
                                        <SelectTrigger className={classNames?.input}>
                                            <SelectValue placeholder={t`Add a model...`} />
                                        </SelectTrigger>
                                        <SelectContent>
                                            {AVAILABLE_MODELS.filter((m) => !selectedModelSet.has(m)).map((model) => (
                                                <SelectItem key={model} value={model}>
                                                    {model}
                                                </SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                </div>
                            </>
                        )}
                    </CardContent>
                </SettingsCard>
            </form>
        </form.AppForm>
    );
};

const BillingSettingsCardSkeleton = ({ className, classNames, ...properties }: SettingsCardProperties) => {
    const { t } = useLingui();

    return (
        <SettingsCard
            actionLabel={t`Save`}
            className={className}
            classNames={classNames}
            description={t`Configure the billing contact and available AI models`}
            isPending
            title={t`Billing Settings`}
            {...properties}
        >
            <CardContent className={cn("space-y-4", classNames?.content)}>
                <Skeleton className={cn("h-9 w-full", classNames?.skeleton)} />
                <Skeleton className={cn("h-9 w-full", classNames?.skeleton)} />
                <Skeleton className={cn("h-20 w-full", classNames?.skeleton)} />
            </CardContent>
        </SettingsCard>
    );
};

const BillingSettingsCard = ({ className, classNames, ...properties }: SettingsCardProperties) => {
    const { authClient } = useAuth();

    const { data: activeOrganization, isPending } = useActiveOrganization(authClient);

    if (isPending) {
        return <BillingSettingsCardSkeleton className={className} classNames={classNames} {...properties} />;
    }

    // No organization: the personal plan card is the whole billing page.
    if (!activeOrganization) {
        return null;
    }

    return <BillingSettingsForm className={className} classNames={classNames} {...properties} />;
};

export default BillingSettingsCard;
