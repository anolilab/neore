//! Device execution for the Neore desktop shell (`docs/plans/device-execution.md`).
//!
//! No UI: the host supplies an event sink (see [`engine::Sink`])
//! and calls [`engine::DeviceState`]. The Electron shell reaches it through
//! `@neore/device-core-node`. Every security decision lives here: envelope
//! signatures, approval rules, root confinement, the shell sandbox, output caps
//! and the audit log.

pub mod approval;
pub mod engine;
pub mod envelope;
pub mod fs;
pub mod hmac;
pub mod mcp;
pub mod sandbox;
pub mod shell;
pub mod store;

pub use engine::{DeviceState, Event, Sink};
