//! Device execution for the Neore desktop shell.
//!
//! No UI: the host supplies an event sink (see [`engine::Sink`])
//! and calls [`engine::DeviceState`]. The Electron shell reaches it through
//! `@neore/device-core-node`. Every security decision on the paired side lives
//! here: envelope signatures, approval rules, root confinement, the shell
//! sandbox, output caps and the audit log.
//!
//! The `keychain` feature (default) is that paired side: `approval`, `envelope`,
//! `engine`, `install`, `ssh` and `store`. Without it the crate is what `neore-host` runs: the
//! `actions` the desktop already approved, over the [`host`] frame protocol.

#[cfg(feature = "keychain")]
pub mod acp;
pub mod acp_permission;
pub mod actions;
#[cfg(feature = "keychain")]
pub mod approval;
#[cfg(feature = "keychain")]
pub mod engine;
#[cfg(feature = "keychain")]
pub mod envelope;
pub mod frame;
pub mod fs;
#[cfg(feature = "keychain")]
pub mod hmac;
pub mod host;
#[cfg(feature = "keychain")]
pub mod install;
pub mod mcp;
pub mod media;
pub mod sandbox;
pub mod shell;
#[cfg(feature = "keychain")]
pub mod ssh;
#[cfg(feature = "keychain")]
pub mod store;

#[cfg(feature = "keychain")]
pub use engine::{DeviceState, Event, Sink};

// The action vectors (`tests/common`) name the crate as an outside user would.
#[cfg(all(test, feature = "keychain"))]
extern crate self as device_core;
#[cfg(all(test, feature = "keychain"))]
#[path = "../tests/common/vectors.rs"]
mod vectors;
