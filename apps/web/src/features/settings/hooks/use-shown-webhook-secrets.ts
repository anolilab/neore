import { useCallback, useState } from "react";

export interface ShownWebhookSecret {
    id: string;
    name: string;
    secret: string;
}

/**
 * Webhook secrets that were returned once and not yet dismissed, one per trigger. A second rotation or creation
 * adds its own entry instead of replacing one the person has not copied yet.
 */
export const useShownWebhookSecrets = () => {
    const [secrets, setSecrets] = useState<ShownWebhookSecret[]>([]);

    const show = useCallback((entry: ShownWebhookSecret) => {
        setSecrets((current) => [...current.filter((item) => item.id !== entry.id), entry]);
    }, []);

    const dismiss = useCallback((id: string) => {
        setSecrets((current) => current.filter((item) => item.id !== id));
    }, []);

    return { dismiss, secrets, show };
};
