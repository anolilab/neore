import { installGlobalErrorReporting } from "./crash-reporting";

// Imported first by the root layout, so the handler is in place before the first render. An error there is held until
// the saved choice is known, rather than being lost.
installGlobalErrorReporting();
