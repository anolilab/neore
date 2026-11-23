import type { screen } from "storybook/test";
import { expect, waitFor } from "storybook/test";

/**
 * Finds a button and waits until it can be pressed. A disabled button has `pointer-events: none`, and a click on it
 * throws: a button that turns on once its data is in the query cache can trail the mock's answer (`lunoraAnswered`).
 * The button is queried again on every poll, so a remount during the wait never leaves it checking a detached node.
 */
export const pressable = async (root: Pick<typeof screen, "findByRole" | "getByRole">, name: string): Promise<HTMLElement> => {
    await root.findByRole("button", { name });

    await waitFor(async () => {
        await expect(root.getByRole("button", { name })).toBeEnabled();
    });

    return root.getByRole("button", { name });
};
