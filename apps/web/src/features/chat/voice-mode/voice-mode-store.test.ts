import { afterEach, describe, expect, it } from "vitest";

import { useVoiceModeStore } from "./voice-mode-store";

afterEach(() => {
    useVoiceModeStore.setState({ controllerOwner: null });
});

describe("voice mode controller ownership", () => {
    it("lets only one toggle own the loop", () => {
        const { claimController } = useVoiceModeStore.getState();

        claimController("hero");
        claimController("sticky");

        expect(useVoiceModeStore.getState().controllerOwner).toBe("hero");
    });

    it("hands the loop to the toggle that was clicked", () => {
        const { claimController } = useVoiceModeStore.getState();

        claimController("hero");
        claimController("sticky", true);

        expect(useVoiceModeStore.getState().controllerOwner).toBe("sticky");
    });

    it("frees the claim only for its owner, so another toggle can take over", () => {
        const { claimController, releaseController } = useVoiceModeStore.getState();

        claimController("hero");
        releaseController("sticky");

        expect(useVoiceModeStore.getState().controllerOwner).toBe("hero");

        releaseController("hero");

        expect(useVoiceModeStore.getState().controllerOwner).toBeNull();

        claimController("sticky");

        expect(useVoiceModeStore.getState().controllerOwner).toBe("sticky");
    });
});
