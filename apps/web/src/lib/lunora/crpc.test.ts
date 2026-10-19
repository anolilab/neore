import { describe, expect, it, vi } from "vitest";

import type { ApiPath } from "./crpc";
import { runLunoraAction } from "./crpc";
import { forgetAllUnlockProofs, rememberUnlockProof } from "./unlock-proofs";

describe("ApiPath (the type NEVER_LIVE is keyed by)", () => {
    it("accepts a generated procedure path and rejects a typo at typecheck", () => {
        const known: ApiPath = "chat_functions:searchThreads";
        // @ts-expect-error — not a procedure: a renamed or misspelled NEVER_LIVE key fails `pnpm lint:types`.
        const typo: ApiPath = "chat_functions:serchThreads";

        expect([known, typo]).toHaveLength(2);
    });
});

describe("action calls on a locked chat the user unlocked", () => {
    it("send the in-memory proof, for the mutation hook and the action hook alike", async () => {
        rememberUnlockProof("thread-1", "proof-1", Date.now() + 60_000);

        const action = vi.fn(async () => null);

        // `useLunoraActionOptions` and `useAction` both go through `runLunoraAction`.
        await runLunoraAction({ action } as never, { name: "updateThread" } as never, { threadId: "thread-1", title: "Renamed" });

        expect(action).toHaveBeenCalledWith({ name: "updateThread" }, { threadId: "thread-1", title: "Renamed", unlockProof: "proof-1" }, {});

        forgetAllUnlockProofs();
    });

    it("sends no proof for a chat the user has not unlocked", async () => {
        const action = vi.fn(async () => null);

        await runLunoraAction({ action } as never, { name: "updateThread" } as never, { threadId: "thread-2", title: "Renamed" });

        expect(action).toHaveBeenCalledWith({ name: "updateThread" }, { threadId: "thread-2", title: "Renamed" }, {});
    });
});
