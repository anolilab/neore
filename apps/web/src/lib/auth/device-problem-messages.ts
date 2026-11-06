import { msg } from "@lingui/core/macro";

import type { DeviceProblem } from "./device-problem";

/**
 * What the approval page says for each problem. The page serves two kinds of code (the command line's sign-in and a
 * headless machine's pairing) and a failed lookup does not say which one it was, so the recovery names both commands.
 */
export const DEVICE_PROBLEM_MESSAGES = {
    expired: msg`This code has expired. Run \`neore login --device\` or \`neore-host pair\` again, whichever you started, to get a new one.`,
    invalid: msg`This code is not valid, or it was already used. Run \`neore login --device\` or \`neore-host pair\` again, whichever you started, to get a new one.`,
    keyLimit: msg`Your account already has the maximum number of API keys, so the command line was not signed in. Revoke one in Settings, then run \`neore login --device\` again.`,
    notAllowed: msg`This session cannot use a code: a guest session, or an admin impersonating someone, cannot approve one. Sign in to your own account, then open the code again.`,
    unavailable: msg`The code could not be checked right now. Try again in a moment.`,
} satisfies Record<DeviceProblem, ReturnType<typeof msg>>;
