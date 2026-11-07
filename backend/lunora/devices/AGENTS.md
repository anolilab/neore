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
