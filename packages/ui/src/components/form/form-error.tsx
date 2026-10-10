"use client";

import { useLingui } from "@lingui/react/macro";
import { AlertCircle } from "lucide-react";
import type { FC } from "react";

import cn from "../../utils/cn";
import { Alert, AlertDescription, AlertTitle } from "../alert";

/**
 * The one slot this component styles.
 *
 * This used to be the app's `AuthFormClassNames`, imported through the app's own
 * `@/features/...` alias — a shared UI package reaching into the application it
 * is consumed by, via a path this package does not even map. Only `error` was
 * ever read, so the contract lives here now and the app's wider type structurally
 * satisfies it.
 */
export interface FormErrorClassNames {
    error?: string;
}

export interface FormErrorProperties {
    classNames?: FormErrorClassNames;
    error?: string;
    title?: string;
}

const FormError: FC<FormErrorProperties> = ({ classNames, error, title }) => {
    const { t } = useLingui();

    if (!error) {
        return null;
    }

    return (
        <Alert className={cn(classNames?.error)} variant="destructive">
            <AlertCircle className="self-center" />
            <AlertTitle>{title || t`Error`}</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
        </Alert>
    );
};

export default FormError;
