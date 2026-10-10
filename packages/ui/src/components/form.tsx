import { createFormHook, createFormHookContexts, useStore } from "@tanstack/react-form";
import * as React from "react";

import cn from "../utils/cn";
import Slot from "./slot";

const { fieldContext, formContext, useFieldContext: useFormFieldContext, useFormContext } = createFormHookContexts();

type FormItemContextValue = {
    id: string;
    required?: boolean;
};

const FormItemContext = React.createContext<FormItemContextValue>({} as FormItemContextValue);

interface FormItemProperties extends React.ComponentProps<"div"> {
    required?: boolean;
}

const FormItem = ({ className, required, ...properties }: FormItemProperties) => {
    const id = React.useId();
    const contextValue = React.useMemo(() => {
        return { id, required };
    }, [id, required]);

    return (
        <FormItemContext value={contextValue}>
            <div className={cn("grid gap-2", className)} data-slot="form-item" {...properties} />
        </FormItemContext>
    );
};

const useFieldContext = () => {
    const { id, required } = React.use(FormItemContext);
    const { name, store, ...restFieldContext } = useFormFieldContext();

    const errors = useStore(store, (state) => state.meta.errors);

    if (!restFieldContext) {
        throw new Error("useFieldContext should be used within <FormItem>");
    }

    return {
        errors,
        formDescriptionId: `${id}-form-item-description`,
        formItemId: `${id}-form-item`,
        formMessageId: `${id}-form-item-message`,
        id,
        name,
        required,
        ...restFieldContext,
    };
};

interface FormLabelProperties extends React.ComponentProps<"label"> {
    required?: boolean;
}

const FormLabel = ({ children, className, required, ...properties }: FormLabelProperties) => {
    const { errors, formItemId, required: contextRequired } = useFieldContext();
    const isRequired = required ?? contextRequired;

    return (
        <label
            className={cn(
                "data-[error=true]:text-destructive flex items-center gap-2 text-sm leading-none font-medium select-none group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50 peer-disabled:cursor-not-allowed peer-disabled:opacity-50",
                className,
            )}
            data-error={errors.length > 0}
            data-slot="form-label"
            htmlFor={formItemId}
            {...properties}
        >
            {children}
            {isRequired && <span className="text-destructive ml-1">*</span>}
        </label>
    );
};

interface FormControlProperties extends React.ComponentProps<typeof Slot> {
    required?: boolean;
}

/**
 * Adopt whatever the control already holds when the field mounts.
 *
 * These forms are server-rendered, so the inputs paint and accept typing before
 * React attaches. Anything entered in that window lives only in the DOM: the
 * field's state is still its empty default, and the first re-render after
 * hydration paints that emptiness back over the user's text. On the sign-up page
 * the re-render arrived when the Turnstile widget mounted, seconds later — so
 * the fields visibly cleared themselves, and submitting then reported "Name is
 * required" over inputs the user had watched go blank.
 *
 * Reading the control on mount closes the window. Only ever promotes a non-empty
 * DOM value into an empty field, so it cannot fight a field that has real state,
 * and it is confined to string-valued fields — a checkbox's `.value` is the
 * literal "on", which would be nonsense to adopt.
 */
const useAdoptPrehydrationValue = (field: { handleChange: (value: never) => void; state: { value: unknown } }): ((node: HTMLElement | null) => void) => {
    const adopted = React.useRef(false);

    return React.useCallback(
        (node: HTMLElement | null) => {
            if (adopted.current || !node) {
                return;
            }

            // `Slot` renders a wrapper unless the caller passes `render`, so the
            // ref usually lands on that rather than on the control itself.
            const control = (node.matches("input, textarea, select") ? node : node.querySelector("input, textarea, select")) as HTMLInputElement | null;

            if (!control || control.type === "checkbox" || control.type === "radio" || typeof control.value !== "string" || control.value === "") {
                return;
            }

            if (typeof field.state.value === "string" && field.state.value === "") {
                adopted.current = true;
                field.handleChange(control.value as never);
            }
        },
        [field],
    );
};

const FormControl = ({ required, ...properties }: FormControlProperties) => {
    const { errors, formDescriptionId, formItemId, formMessageId, required: contextRequired } = useFieldContext();
    const field = useFormFieldContext();
    const isRequired = required ?? contextRequired;
    const adoptRef = useAdoptPrehydrationValue(field);

    return (
        <Slot
            aria-describedby={errors.length === 0 ? formDescriptionId : `${formDescriptionId} ${formMessageId}`}
            aria-invalid={errors.length > 0}
            aria-required={isRequired}
            data-required={isRequired}
            data-slot="form-control"
            id={formItemId}
            {...properties}
            ref={adoptRef}
        />
    );
};

const FormDescription = ({ className, ...properties }: React.ComponentProps<"p">) => {
    const { formDescriptionId } = useFieldContext();

    return <p className={cn("text-muted-foreground text-sm", className)} data-slot="form-description" id={formDescriptionId} {...properties} />;
};

const FormMessage = ({ className, ...properties }: React.ComponentProps<"p">) => {
    const { errors, formMessageId } = useFieldContext();
    const body = errors.length > 0 ? String(errors.at(0)?.message ?? "") : properties.children;

    if (!body) {
        return null;
    }

    return (
        <p className={cn("text-destructive text-sm", className)} data-slot="form-message" id={formMessageId} {...properties}>
            {body}
        </p>
    );
};

const { useAppForm, withForm } = createFormHook({
    fieldComponents: {
        FormControl,
        FormDescription,
        FormItem,
        FormLabel,
        FormMessage,
    },
    fieldContext,
    formComponents: {},
    formContext,
});

export { FormControl, FormDescription, FormItem, FormLabel, FormMessage, useAppForm, useFieldContext, useFormContext, withForm };
