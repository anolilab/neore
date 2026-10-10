import { createIsomorphicFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";

const getHeaders = createIsomorphicFn()
    .server(async () => getRequestHeaders())
    .client(() => {
        return {};
    });

export default getHeaders;
