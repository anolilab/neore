"use client";

import * as React from "react";

import { IsMobileContext } from "./responsive-dialog-context";

/**
 * Hook to check if the responsive dialog is rendering in mobile (drawer) mode.
 */
const useIsResponsiveDialogMobile = () => React.use(IsMobileContext);

export { useIsResponsiveDialogMobile };
