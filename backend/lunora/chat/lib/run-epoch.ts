/**
 * Which run holds a stream. The first claim is epoch 0 (nothing stored); each resume claim (`claimRunResume`) is one more.
 * A run that lost its stream to a newer one (it was slow, not dead: a busy shard, a long setup) must not go on writing
 * beside it, so every write that matters carries the run's epoch and a stale one is refused with `RUN_REPLACED`, which
 * the run answers by stopping quietly.
 */
import { LunoraError } from "lunorash/server";

export const RUN_REPLACED = "RUN_REPLACED";

/** The epoch the stream is at, as the run that claimed it first counts it. */
export const epochOf = (stream: { runEpoch?: number }): number => stream.runEpoch ?? 0;

/** Throws `RUN_REPLACED` when `epoch` is given and a newer run holds the stream. A write with no epoch (other run kinds) is not checked. */
export const assertCurrentRun = (stream: { runEpoch?: number }, epoch: number | undefined): void => {
    if (epoch !== undefined && epochOf(stream) !== epoch) {
        throw new LunoraError(RUN_REPLACED, "A newer run holds this stream");
    }
};

/** The error code of a thrown error: a `LunoraError` carries `code`, one decoded off the wire carries it in `data`. */
export const errorCodeOf = (error: unknown): string | undefined => {
    const { code, data } = (error ?? {}) as { code?: unknown; data?: { code?: unknown } };
    const found = code ?? data?.code;

    return typeof found === "string" ? found : undefined;
};

export const isRunReplaced = (error: unknown): boolean => errorCodeOf(error) === RUN_REPLACED;
