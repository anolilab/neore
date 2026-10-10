"use client";

import { createRequestChannel } from "@/features/chat/core/stores/request-channel-store";

import type { CatalogServer } from "./types";

/**
 * "Open the add-server form prefilled with this catalogue server", from another
 * surface (the skill Agent Builder). `MCPSettings` consumes it in an effect; the
 * user still reviews and saves the form — nothing is added from here.
 *
 * Publish only from a click handler, so a request never exists during SSR.
 */
const mcpInstallChannel = createRequestChannel<CatalogServer>();

export const requestMcpInstall = (server: CatalogServer): void => mcpInstallChannel.request(server);

export const consumeMcpInstallRequests = (handler: (server: CatalogServer) => void): (() => void) => mcpInstallChannel.consume(handler);
