/**
 * Typed PostHog event catalog.
 *
 * Every custom event we send to PostHog MUST be listed here so that
 * names stay consistent and are discoverable via TypeScript.
 */

// ── Auth ────────────────────────────────────────────────────────────────────
export interface SignedUpProperties {
    provider: string;
}

export interface SignedInProperties {
    provider: string;
}

export interface AnonymousConvertedProperties {
    provider: string;
}

export interface AnonymousSessionStartedProperties {
    referrer?: string;
}

// ── Chat ────────────────────────────────────────────────────────────────────

export interface MessageCopiedProperties {
    role: string;
}

export interface MessageRegeneratedProperties {
    model: string;
}

export interface SignupWallShownProperties {
    trigger: string;
}
export interface ThreadCreatedProperties {
    mode?: string;
    model: string;
}

export interface MessageSentProperties {
    attachment_count: number;
    has_attachments: boolean;
    model: string;
    thread_mode?: string;
}

export interface ModelSwitchedProperties {
    from_model: string;
    to_model: string;
}

export interface FileUploadedProperties {
    file_type: string;
}

export interface ThreadBranchedProperties {
    parent_model?: string;
}

// ── Stream ──────────────────────────────────────────────────────────────────
export interface StreamStartedProperties {
    model: string;
}

export interface StreamCompletedProperties {
    model: string;
}

export interface StreamErrorProperties {
    error_type: string;
    model: string;
}

export interface StreamCancelledProperties {
    model: string;
}

// ── Canvas ──────────────────────────────────────────────────────────────────
export interface ArtifactCreatedProperties {
    kind: string;
}

export interface ArtifactEditedProperties {
    kind: string;
}

// ── Settings ────────────────────────────────────────────────────────────────
export interface SettingsChangedProperties {
    section: string;
    setting_key: string;
}

export interface ApiKeyAddedProperties {
    provider: string;
}

export interface MemoryToggledProperties {
    enabled: boolean;
}

export interface DefaultModelChangedProperties {
    mode?: string;
    model: string;
}

// ── Messenger ───────────────────────────────────────────────────────────────
export interface MessengerConnectedProperties {
    platform: string;
}

export interface MessengerDisconnectedProperties {
    platform: string;
}

// ── Pins ────────────────────────────────────────────────────────────────────
export interface MessagePinnedProperties {
    has_note: boolean;
}

// ── Chat Import ─────────────────────────────────────────────────────────────
export interface ChatImportStartedProperties {
    conversation_count: number;
    provider: string;
}

export interface ChatImportCompletedProperties {
    conversation_count: number;
    provider: string;
}

export interface ChatImportFailedProperties {
    error_type: string;
    provider: string;
}

// ── Onboarding ──────────────────────────────────────────────────────────────
export interface OnboardingStepCompletedProperties {
    step_id: string;
    step_index: number;
}

export interface OnboardingSkippedProperties {
    at_step: string;
}

// ── Event map ───────────────────────────────────────────────────────────────

export interface AnalyticsEventMap {
    anonymous_converted: AnonymousConvertedProperties;
    anonymous_session_started: AnonymousSessionStartedProperties;
    api_key_added: ApiKeyAddedProperties;
    artifact_created: ArtifactCreatedProperties;
    artifact_edited: ArtifactEditedProperties;
    chat_import_completed: ChatImportCompletedProperties;
    chat_import_failed: ChatImportFailedProperties;
    chat_import_started: ChatImportStartedProperties;
    default_model_changed: DefaultModelChangedProperties;
    file_uploaded: FileUploadedProperties;
    memory_toggled: MemoryToggledProperties;
    message_copied: MessageCopiedProperties;
    message_edited: Record<string, never>;
    message_pinned: MessagePinnedProperties;
    message_regenerated: MessageRegeneratedProperties;
    message_sent: MessageSentProperties;
    message_unpinned: Record<string, never>;
    messenger_connected: MessengerConnectedProperties;
    messenger_disconnected: MessengerDisconnectedProperties;
    model_switched: ModelSwitchedProperties;
    onboarding_completed: Record<string, never>;
    onboarding_skipped: OnboardingSkippedProperties;
    onboarding_started: Record<string, never>;
    onboarding_step_completed: OnboardingStepCompletedProperties;
    settings_changed: SettingsChangedProperties;
    signed_in: SignedInProperties;
    signed_out: Record<string, never>;
    signed_up: SignedUpProperties;
    signup_wall_shown: SignupWallShownProperties;
    stream_cancelled: StreamCancelledProperties;
    stream_completed: StreamCompletedProperties;
    stream_error: StreamErrorProperties;
    stream_started: StreamStartedProperties;
    thread_branched: ThreadBranchedProperties;
    thread_created: ThreadCreatedProperties;
    thread_deleted: Record<string, never>;
}

export type AnalyticsEvent = keyof AnalyticsEventMap;
