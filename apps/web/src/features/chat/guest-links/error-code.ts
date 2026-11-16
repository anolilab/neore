/**
 * The backend's error code for a refused call (`LunoraError`): its own `data.code` when it names one (`chat/guest-links.ts`),
 * else the standard `code`.
 */
export const errorCode = (error: unknown): unknown => {
    const { code, data } = (typeof error === "object" && error !== null ? error : {}) as { code?: unknown; data?: { code?: unknown } };

    return data?.code ?? code;
};
