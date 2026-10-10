import type { MessageDescriptor } from "@lingui/core";
import { useLingui } from "@lingui/react/macro";

import { ErrorUtilities } from "./errors";

/**
 * Renders a message descriptor in the reader's language.
 *
 * For code that builds UI outside a component body — toast helpers, error
 * boundary render callbacks — where `useLingui()` cannot be called. It must
 * still render inside the app's `I18nProvider` (the toaster and the error
 * boundaries do).
 */
export const LocalizedMessage = ({ message }: { message: MessageDescriptor }) => {
    const { i18n } = useLingui();

    return <>{i18n._(message)}</>;
};

/**
 * Renders `ErrorUtilities.getUserMessage` for an error, translated.
 */
export const UserErrorMessage = ({ error }: { error: Error }) => {
    const { i18n } = useLingui();

    return <>{ErrorUtilities.getUserMessage(error, i18n)}</>;
};
