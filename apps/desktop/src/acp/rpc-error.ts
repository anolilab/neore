/** An error a JSON-RPC peer reported, or one the host answers with. */
export const METHOD_NOT_FOUND = -32_601;
export const INTERNAL_ERROR = -32_603;
export const INVALID_PARAMS = -32_602;

export class RpcError extends Error {
    public readonly code: number;

    public constructor(code: number, message: string) {
        super(message);
        this.name = "RpcError";
        this.code = code;
    }
}
