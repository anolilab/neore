export const SETUP_STEP_IDS = ["pair", "ssh", "agent"] as const;

export type SetupStepId = (typeof SETUP_STEP_IDS)[number];

export type SetupStepStatus = "done" | "skipped" | "todo";

export interface SetupDevice {
    acpOffers?: ReadonlyArray<unknown>;
    /** Set once the desktop app has reported in, which only a confirmed device does. */
    lastSeenAt?: number;
    transport?: "headless" | "ssh";
}

/**
 * What the live device list says is already true. Only a device that has reported in counts: its row exists before the
 * desktop app has confirmed the pairing. An agent offer counts on a paired computer, not on an SSH server.
 */
export const detectSetupDone = (devices: ReadonlyArray<SetupDevice> | undefined): Record<SetupStepId, boolean> => {
    const list = (devices ?? []).filter((device) => device.lastSeenAt !== undefined);
    const paired = list.filter((device) => device.transport !== "ssh");

    return {
        agent: paired.some((device) => (device.acpOffers?.length ?? 0) > 0),
        pair: paired.length > 0,
        ssh: list.some((device) => device.transport === "ssh"),
    };
};

/** Done wins over skipped: a step the user skipped completes once its state appears. */
export const deriveSetupSteps = (
    devices: ReadonlyArray<SetupDevice> | undefined,
    skipped: ReadonlyArray<string> | undefined,
): { id: SetupStepId; status: SetupStepStatus }[] => {
    const done = detectSetupDone(devices);

    return SETUP_STEP_IDS.map((id) => {
        if (done[id] === true) {
            return { id, status: "done" };
        }

        return { id, status: skipped?.includes(id) ? "skipped" : "todo" };
    });
};

/** The skipped list after a skip or a resume; ids stored by other versions are kept. The server applies the same change and its cap. */
export const toggleSkipped = (skipped: ReadonlyArray<string> | undefined, id: SetupStepId, skip: boolean): string[] => {
    const rest = (skipped ?? []).filter((entry) => entry !== id);

    return skip ? [...rest, id] : rest;
};
