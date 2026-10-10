import type { ArgsOf, FunctionReference } from "@lunora/react";
import type { SyncStreamsReturnValue } from "@neore/backend/agent/types";
import type { StreamArgs } from "@neore/backend/agent/validators";

import type { BetterOmit, Expand } from "./type-utilities";

// Three type parameters, not the old four — Lunora dropped the visibility slot
// and encodes it by which generated object the reference lives on (`api` vs
// `internal`). See the same note in `use-uimessages.ts`.
export type StreamQuery<Args = Record<string, unknown>> = FunctionReference<
    "query",
    Args & {
        streamArgs?: StreamArgs; // required for stream query
        threadId: string;
    },
    { streams: SyncStreamsReturnValue }
>;

export type StreamQueryArgs<Query extends StreamQuery<unknown>> = Query extends StreamQuery<unknown> ? Expand<BetterOmit<ArgsOf<Query>, "streamArgs">> : never;
