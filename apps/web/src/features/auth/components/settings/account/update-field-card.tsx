"use client";

import { useLingui } from "@lingui/react/macro";
import { CardContent } from "@neore/ui/components/card";
import { Checkbox } from "@neore/ui/components/checkbox";
import { useAppForm } from "@neore/ui/components/form";
import { Input } from "@neore/ui/components/input";
import { Skeleton } from "@neore/ui/components/skeleton";
import cn from "@neore/ui/utils/cn";
import type { ReactNode } from "react";
import * as z from "zod";

import type { SettingsCardClassNames } from "@/components/settings/settings-card";
import SettingsCard from "@/components/settings/settings-card";
import { useSession } from "@/features/auth/hooks/session-user-management";
import { useAuth } from "@/features/auth/lib/auth-ui-provider";

import { getLocalizedError } from "../../../lib/utilities";
import type { FieldType } from "../../../types/form-validation-types";

export interface UpdateFieldCardProperties {
    className?: string;
    classNames?: SettingsCardClassNames;
    description?: ReactNode;
    instructions?: ReactNode;

    label?: ReactNode;
    name: string;
    placeholder?: string;
    required?: boolean;
    type?: FieldType;
    validate?: (value: string) => boolean | Promise<boolean>;
    value?: unknown;
}

const UpdateFieldCard = ({
    className,
    classNames,
    description,
    instructions,
    label,
    name,
    placeholder,
    required,
    type,
    validate,
    value,
}: UpdateFieldCardProperties) => {
    const {
        authClient,
        mutators: { updateUser },
        toast,
    } = useAuth();
    const { t } = useLingui();
    // The field's name inside each message, so a translation can place it.
    const fieldLabel = String(label ?? "");

    const { isPending, refetch } = useSession(authClient);

    // Create the appropriate schema based on type
    let fieldSchema = z.unknown() as z.ZodType;

    if (type === "number") {
        fieldSchema = required
            ? z.preprocess(
                  (value_) => (value_ ? Number(value_) : undefined),
                  z.number({
                      error: t`${fieldLabel} is required`,
                  }),
              )
            : z.coerce
                  .number({
                      error: t`${fieldLabel} is invalid`,
                  })
                  .optional();
    } else if (type === "boolean") {
        // `z.preprocess(Boolean, …)` rather than `z.coerce.boolean()`: same
        // `Boolean(input)` conversion, without the coercion footgun where the
        // string "false" reads as true.
        fieldSchema = required
            ? z.preprocess(Boolean, z.boolean()).refine((value_) => value_, {
                  error: t`${fieldLabel} is required`,
              })
            : z.preprocess(Boolean, z.boolean());
    } else {
        fieldSchema = required ? z.string().min(1, t`${fieldLabel} is required`) : z.string().optional();
    }

    const form = useAppForm({
        defaultValues: {
            [name]: value || "",
        },
        onSubmit: async ({ value: values }) => {
            await new Promise((resolve) => {
                setTimeout(resolve, 0);
            });
            const newValue = values[name];

            if (value === newValue) {
                toast({
                    message: t`${fieldLabel} is the same as current value`,
                    variant: "error",
                });

                return;
            }

            if (validate && typeof newValue === "string" && !(await validate(newValue))) {
                form.setErrorMap({
                    [name]: t`${fieldLabel} is invalid`,
                });

                return;
            }

            try {
                await updateUser({ [name]: newValue });

                await refetch?.();
                toast({
                    message: t`${fieldLabel} updated successfully`,
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
            onChange: ({ value: formValue }) => {
                const result = fieldSchema.safeParse(formValue[name]);

                if (!result.success) {
                    return { [name]: result.error.issues[0]?.message };
                }

                return undefined;
            },
        },
    });

    const { isSubmitting } = form.state;

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
                    description={description}
                    instructions={instructions}
                    isPending={isPending}
                    title={label}
                >
                    <CardContent className={classNames?.content}>
                        {type === "boolean" && (
                            <form.AppField name={name}>
                                {(field) => (
                                    <field.FormItem className="flex">
                                        <field.FormControl>
                                            <Checkbox
                                                checked={field.state.value as boolean}
                                                className={classNames?.checkbox}
                                                disabled={isSubmitting}
                                                onCheckedChange={(checked) => {
                                                    field.handleChange(checked as boolean);
                                                }}
                                            />
                                        </field.FormControl>

                                        <field.FormLabel className={classNames?.label}>{label}</field.FormLabel>

                                        <field.FormMessage className={classNames?.error} />
                                    </field.FormItem>
                                )}
                            </form.AppField>
                        )}
                        {type !== "boolean" && isPending && <Skeleton className={cn("h-9 w-full", classNames?.skeleton)} />}
                        {type !== "boolean" && !isPending && (
                            <form.AppField name={name}>
                                {(field) => (
                                    <field.FormItem>
                                        <field.FormControl>
                                            <Input
                                                autoComplete={name === "name" || name === "username" ? name : "off"}
                                                className={classNames?.input}
                                                disabled={isSubmitting}
                                                onBlur={field.handleBlur}
                                                onChange={(e) => {
                                                    field.handleChange(e.target.value);
                                                }}
                                                placeholder={placeholder}
                                                type={type === "number" ? "number" : "text"}
                                                value={field.state.value as string}
                                            />
                                        </field.FormControl>

                                        <field.FormMessage className={classNames?.error} />
                                    </field.FormItem>
                                )}
                            </form.AppField>
                        )}
                    </CardContent>
                </SettingsCard>
            </form>
        </form.AppForm>
    );
};

export default UpdateFieldCard;
