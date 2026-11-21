# DEVICES — AGENT NOTES

## INVARIANTS

- **Chat status** comes from the device too: Rust emits a SIGNED
  `neore:device:progress` report (domain `progress`: `prompting` when the
  approval window shows the call, `running` before it runs) that the relay
  forwards to `reportDeviceCallProgress` — forward-only on a `claimed` call,
  display only, it can never finish one. The chat's device row
  (`features/devices/components/device-tool-call.tsx`, picked by the
  `device_<tag>__<tool>` runtime name, `@neore/chat-ui/utils/device-tool-name`)
  subscribes to `getDeviceCallByToolCall` ONLY while the tool part is in
  flight; a finished call reads its outcome from the tool output's `status`.
- **A machine paired by code** (`registerHeadlessDevice`) is found again by
  `pairedByCode`, because the auth route puts the code back after any answer
  that may be lost. Whether a code may still pair lives on the owner's shard
  (`devicePairingRevocations`, written by `revokeDevice`), never on the global
  `deviceCode` row: the two stores do not commit together.
- **The one call no chat starts** (`global-instructions.ts`): the rule-file editor's "Import from this computer"
  signs `instructions_list` / `instructions_read` for the caller's own desktop (never a server or a machine paired
  by code), with no thread (`deviceCalls.threadId` is optional for it alone). The request names ids from a fixed
  list; the paths live only in Rust (`device-core/src/global_instructions.rs`), keep the two id lists in step.
