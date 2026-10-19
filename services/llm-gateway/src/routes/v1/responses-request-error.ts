/** A 400 for a field the gateway cannot honour. `param` names the offending field. */
export class ResponsesRequestError extends Error {
    readonly param: string | null;

    constructor(message: string, parameter: string | null) {
        super(message);
        this.param = parameter;
    }
}
