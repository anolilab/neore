import { preventAutoHideAsync } from "expo-splash-screen";

import { settleQuietly } from "../offline/quietly";

// Imported by the root layout, so the splash stays up while the stored sign-in is read: a returning person never sees an
// empty list or the sign-in screen before their chats. A failure only means the splash hides on its own.
settleQuietly(preventAutoHideAsync());
