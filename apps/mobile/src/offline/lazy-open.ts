/** Opens on first use and shares the connection; a failed open is forgotten, so the next call tries again. */
export const createLazyOpen = <T>(open: () => Promise<T>): () => Promise<T> => {
    let opening: Promise<T> | undefined;

    const attempt = async (): Promise<T> => {
        try {
            return await open();
        } catch (error: unknown) {
            opening = undefined;

            throw error;
        }
    };

    return () => {
        opening ??= attempt();

        return opening;
    };
};
