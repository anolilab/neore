//! Permission requests from coding agents, answered ONLY in the local device window.
//!
//! The main process registers each `session/request_permission` here and waits for the outcome; the window lists
//! what is waiting and answers it. Rust is the one place that decides what an answer may be, whoever sends it:
//! the agent's own option id, of the kind "allow once" or "reject once", for a request that is still waiting.
//! An "always" option is refused, so an agent can never be told that a choice is remembered.
//!
//! These requests are kept apart from the device prompts (`approval.rs`): a device tool call (`shell_run`,
//! `fs_write`, anything tainted) is decided one call at a time and never joins a batch.

use std::collections::HashSet;
use std::sync::mpsc::{channel, Sender};
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::actions::cap_utf8;

/// How long a request waits for an answer before the agent is told it was cancelled.
const WAIT: Duration = Duration::from_secs(30 * 60);
const MAX_OPTIONS: usize = 16;
const MAX_BATCH: usize = 50;
/// Requests one session may have waiting. Each holds a worker thread for up to `WAIT` and brings the window to
/// the front, so a looping agent must not be able to queue without end: past this it is answered `Cancelled`.
const MAX_WAITING_PER_SESSION: usize = 16;
const MAX_TEXT: usize = 1000;
const MAX_DETAILS: usize = 16 * 1024;

pub const ALLOW_ONCE: &str = "allow_once";
pub const REJECT_ONCE: &str = "reject_once";

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OfferedOption {
    pub kind: String,
    pub name: String,
    pub option_id: String,
}

/// What the main process registers. Everything in it came from the agent, except the session id.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionRequest {
    pub agent_label: String,
    pub command: Option<String>,
    /// The tool call as the agent described it, spelled out. Cut at 16 KiB.
    pub details: String,
    /// Everything the agent sent is in `details`. Without it the request cannot be approved in a batch.
    pub details_complete: bool,
    pub folder: String,
    pub options: Vec<OfferedOption>,
    /// The host's session id, not the agent's.
    pub session_id: String,
    pub target: Option<String>,
    pub tool: String,
    pub tool_kind: String,
}

/// The answer the agent receives: ACP's `RequestPermissionOutcome`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "outcome"
)]
pub enum Outcome {
    Cancelled,
    Selected { option_id: String },
}

/// One answered request, for the audit log.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Answered {
    pub agent_label: String,
    pub decision: &'static str,
    pub id: u64,
    pub target: Option<String>,
    pub tool: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingView {
    pub agent_label: String,
    /// Allow-once is offered and the details are complete: this request may be approved with others.
    pub batchable: bool,
    pub command: Option<String>,
    pub details: String,
    pub details_complete: bool,
    pub folder: String,
    pub id: u64,
    /// The agent's allow-once options. "Always" options are not listed, and a reject is the window's own button.
    pub options: Vec<OfferedOption>,
    pub session_id: String,
    pub target: Option<String>,
    pub tool: String,
    pub tool_kind: String,
}

struct Pending {
    id: u64,
    request: PermissionRequest,
    sender: Sender<Outcome>,
}

#[derive(Default)]
pub struct AcpPermissions {
    next_id: Mutex<u64>,
    queue: Mutex<Vec<Pending>>,
}

/// The options as offered, or none at all when two share an id: the answer names an option by its id, so the
/// button the user pressed could be a different option from the one the agent receives. With none, a request
/// can only be declined or cancelled.
fn distinct_options(options: Vec<OfferedOption>) -> Vec<OfferedOption> {
    let mut seen = HashSet::new();

    if options
        .iter()
        .all(|option| seen.insert(option.option_id.as_str()))
    {
        options
    } else {
        Vec::new()
    }
}

fn allow_option(request: &PermissionRequest) -> Option<&OfferedOption> {
    request
        .options
        .iter()
        .find(|option| option.kind == ALLOW_ONCE)
}

/// What a "no" is for this request: the agent's own reject-once option, or a cancel if it offered none.
fn decline_outcome(request: &PermissionRequest) -> Outcome {
    request
        .options
        .iter()
        .find(|option| option.kind == REJECT_ONCE)
        .map_or(Outcome::Cancelled, |option| Outcome::Selected {
            option_id: option.option_id.clone(),
        })
}

fn is_batchable(request: &PermissionRequest) -> bool {
    request.details_complete && allow_option(request).is_some()
}

fn answered(pending: &Pending, decision: &'static str) -> Answered {
    Answered {
        agent_label: pending.request.agent_label.clone(),
        decision,
        id: pending.id,
        target: pending.request.target.clone(),
        tool: pending.request.tool.clone(),
    }
}

fn limited(text: String, max: usize) -> String {
    cap_utf8(&text, max).0
}

impl AcpPermissions {
    /// Queues a request and blocks until it is answered, cancelled, or `WAIT` passes (which cancels it).
    /// `on_queued` runs once the request is visible, with its id.
    pub fn ask(&self, request: PermissionRequest, on_queued: impl FnOnce(u64)) -> Outcome {
        let request = PermissionRequest {
            agent_label: limited(request.agent_label, MAX_TEXT),
            command: request.command.map(|text| limited(text, MAX_TEXT * 4)),
            details_complete: request.details_complete && request.details.len() <= MAX_DETAILS,
            details: limited(request.details, MAX_DETAILS),
            folder: limited(request.folder, MAX_TEXT),
            // Checked on everything the agent sent, then cut: an id repeated past the cap would otherwise hide.
            options: distinct_options(request.options)
                .into_iter()
                .take(MAX_OPTIONS)
                .collect(),
            session_id: request.session_id,
            target: request.target.map(|text| limited(text, MAX_TEXT)),
            tool: limited(request.tool, MAX_TEXT),
            tool_kind: limited(request.tool_kind, 40),
        };
        let (sender, receiver) = channel();
        let id = {
            let mut queue = self.queue.lock().unwrap();

            if queue
                .iter()
                .filter(|pending| pending.request.session_id == request.session_id)
                .count()
                >= MAX_WAITING_PER_SESSION
            {
                return Outcome::Cancelled;
            }

            let mut next = self.next_id.lock().unwrap();
            *next += 1;
            queue.push(Pending {
                id: *next,
                request,
                sender,
            });
            *next
        };

        on_queued(id);

        receiver.recv_timeout(WAIT).unwrap_or_else(|_| {
            self.queue
                .lock()
                .unwrap()
                .retain(|pending| pending.id != id);

            Outcome::Cancelled
        })
    }

    pub fn view(&self) -> Vec<PendingView> {
        self.queue
            .lock()
            .unwrap()
            .iter()
            .map(|pending| {
                let request = &pending.request;

                PendingView {
                    agent_label: request.agent_label.clone(),
                    batchable: is_batchable(request),
                    command: request.command.clone(),
                    details: request.details.clone(),
                    details_complete: request.details_complete,
                    folder: request.folder.clone(),
                    id: pending.id,
                    options: request
                        .options
                        .iter()
                        .filter(|option| option.kind == ALLOW_ONCE)
                        .cloned()
                        .collect(),
                    session_id: request.session_id.clone(),
                    target: request.target.clone(),
                    tool: request.tool.clone(),
                    tool_kind: request.tool_kind.clone(),
                }
            })
            .collect()
    }

    /// Answers one request with one of the agent's own options. The first answer wins; a later one finds nothing.
    pub fn answer(&self, id: u64, option_id: &str) -> Result<Answered, String> {
        let mut queue = self.queue.lock().unwrap();
        let index = queue
            .iter()
            .position(|pending| pending.id == id)
            .ok_or("that request is no longer waiting")?;
        let option = queue[index]
            .request
            .options
            .iter()
            .find(|option| option.option_id == option_id)
            .ok_or("the agent did not offer that option")?;

        let decision = match option.kind.as_str() {
            ALLOW_ONCE => "once",
            REJECT_ONCE => "deny",
            kind if kind.ends_with("_always") => {
                return Err("\"Always allow\" is not available for coding agents".into());
            }
            _ => return Err("that option is not available".into()),
        };
        let pending = queue.remove(index);
        let summary = answered(&pending, decision);

        let _ = pending.sender.send(Outcome::Selected {
            option_id: option_id.to_owned(),
        });

        Ok(summary)
    }

    /// Says no to one request.
    pub fn decline(&self, id: u64) -> Result<Answered, String> {
        let mut queue = self.queue.lock().unwrap();
        let index = queue
            .iter()
            .position(|pending| pending.id == id)
            .ok_or("that request is no longer waiting")?;
        let pending = queue.remove(index);
        let summary = answered(&pending, "deny");

        let _ = pending.sender.send(decline_outcome(&pending.request));

        Ok(summary)
    }

    /// Allows exactly the requests named, each once, with its own allow-once option. This is a batch of
    /// single answers, not a rule: nothing is remembered, and a request that is not named (one that arrived
    /// after the list was drawn) stays waiting. A named request that was answered meanwhile is skipped.
    ///
    /// All or nothing for the ones still waiting: if any of them is from another session, lacks an allow-once
    /// option or has incomplete details, none is answered.
    pub fn answer_batch(&self, ids: &[u64]) -> Result<Vec<Answered>, String> {
        if ids.is_empty() || ids.len() > MAX_BATCH {
            return Err(format!("name between 1 and {MAX_BATCH} requests"));
        }

        let mut queue = self.queue.lock().unwrap();
        let named: Vec<usize> = queue
            .iter()
            .enumerate()
            .filter(|(_, pending)| ids.contains(&pending.id))
            .map(|(index, _)| index)
            .collect();

        if let Some(first) = named.first() {
            let session = &queue[*first].request.session_id;

            if named
                .iter()
                .any(|index| &queue[*index].request.session_id != session)
            {
                return Err("approve requests from one session at a time".into());
            }

            if named
                .iter()
                .any(|index| !is_batchable(&queue[*index].request))
            {
                return Err(
                    "not every request can be approved together; answer them one by one".into(),
                );
            }
        }

        // Highest index first, so removing one does not move the next.
        let mut summaries = Vec::new();

        for index in named.into_iter().rev() {
            let pending = queue.remove(index);
            let option_id = allow_option(&pending.request)
                .map(|option| option.option_id.clone())
                .unwrap_or_default();

            summaries.push(answered(&pending, "once"));
            let _ = pending.sender.send(Outcome::Selected { option_id });
        }

        summaries.reverse();

        Ok(summaries)
    }

    /// Answers every request of one session `cancelled`: the host sent `session/cancel`, or the agent ended.
    pub fn cancel_session(&self, session_id: &str) -> usize {
        let mut queue = self.queue.lock().unwrap();
        let (cancelled, kept): (Vec<_>, Vec<_>) = queue
            .drain(..)
            .partition(|pending| pending.request.session_id == session_id);

        *queue = kept;

        for pending in &cancelled {
            let _ = pending.sender.send(Outcome::Cancelled);
        }

        cancelled.len()
    }

    /// Closing the window is a "no" to everything it was asking.
    pub fn decline_all(&self) -> Vec<Answered> {
        self.queue
            .lock()
            .unwrap()
            .drain(..)
            .map(|pending| {
                let _ = pending.sender.send(decline_outcome(&pending.request));

                answered(&pending, "deny")
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::thread;

    use super::*;

    fn option(id: &str, kind: &str) -> OfferedOption {
        OfferedOption {
            kind: kind.into(),
            name: id.into(),
            option_id: id.into(),
        }
    }

    fn request(session: &str, tool: &str) -> PermissionRequest {
        PermissionRequest {
            agent_label: "Agent".into(),
            command: Some("echo hi".into()),
            details: "{}".into(),
            details_complete: true,
            folder: "/work".into(),
            options: vec![
                option("allow", ALLOW_ONCE),
                option("always", "allow_always"),
                option("reject", REJECT_ONCE),
            ],
            session_id: session.into(),
            target: Some("/work/a.txt".into()),
            tool: tool.into(),
            tool_kind: "execute".into(),
        }
    }

    type Waiting = thread::JoinHandle<Outcome>;

    /// Starts `ask` on its own thread and returns once the request is visible, with its id.
    fn queue(permissions: &Arc<AcpPermissions>, request: PermissionRequest) -> (u64, Waiting) {
        let (seen, ready) = channel();
        let permissions = permissions.clone();
        let handle = thread::spawn(move || {
            permissions.ask(request, |id| {
                seen.send(id).unwrap();
            })
        });

        (ready.recv().unwrap(), handle)
    }

    fn selected(option_id: &str) -> Outcome {
        Outcome::Selected {
            option_id: option_id.into(),
        }
    }

    #[test]
    fn approving_gives_the_agent_its_own_allow_once_option() {
        let permissions = Arc::new(AcpPermissions::default());
        let (id, waiting) = queue(&permissions, request("s1", "Run tests"));

        let summary = permissions.answer(id, "allow").unwrap();

        assert_eq!(summary.decision, "once");
        assert_eq!(waiting.join().unwrap(), selected("allow"));
        assert!(permissions.view().is_empty());
    }

    #[test]
    fn declining_gives_the_agent_its_reject_option_or_a_cancel_when_it_offers_none() {
        let permissions = Arc::new(AcpPermissions::default());
        let (id, waiting) = queue(&permissions, request("s1", "Run tests"));

        permissions.decline(id).unwrap();
        assert_eq!(waiting.join().unwrap(), selected("reject"));

        let mut no_reject = request("s1", "Run tests");
        no_reject
            .options
            .retain(|option| option.kind != REJECT_ONCE);
        let (id, waiting) = queue(&permissions, no_reject);

        permissions.decline(id).unwrap();
        assert_eq!(waiting.join().unwrap(), Outcome::Cancelled);
    }

    #[test]
    fn an_always_option_is_refused_from_any_source_and_the_request_keeps_waiting() {
        let permissions = Arc::new(AcpPermissions::default());
        let mut both = request("s1", "Run tests");
        both.options.push(option("never", "reject_always"));
        let (id, waiting) = queue(&permissions, both);

        for refused in ["always", "never"] {
            let error = permissions.answer(id, refused).unwrap_err();

            assert!(error.contains("Always allow"), "{refused}: {error}");
        }

        assert_eq!(permissions.view().len(), 1);
        // Not offered at all, and unknown kinds, are refused too.
        assert!(permissions.answer(id, "invented").is_err());

        let mut odd = request("s1", "x");
        odd.options = vec![option("odd", "allow_forever")];
        let (odd_id, odd_waiting) = queue(&permissions, odd);

        assert!(permissions.answer(odd_id, "odd").is_err());
        permissions.cancel_session("s1");
        assert_eq!(waiting.join().unwrap(), Outcome::Cancelled);
        assert_eq!(odd_waiting.join().unwrap(), Outcome::Cancelled);
    }

    #[test]
    fn the_view_never_lists_an_always_option() {
        let permissions = Arc::new(AcpPermissions::default());
        let (_, waiting) = queue(&permissions, request("s1", "Run tests"));
        let view = permissions.view();
        let json = serde_json::to_string(&view).unwrap();

        assert_eq!(view[0].options, vec![option("allow", ALLOW_ONCE)]);
        assert!(!json.contains("always"));
        permissions.cancel_session("s1");
        waiting.join().unwrap();
    }

    #[test]
    fn the_first_answer_wins() {
        let permissions = Arc::new(AcpPermissions::default());
        let (id, waiting) = queue(&permissions, request("s1", "Run tests"));

        permissions.answer(id, "allow").unwrap();

        assert!(permissions
            .answer(id, "reject")
            .unwrap_err()
            .contains("no longer waiting"));
        assert!(permissions.decline(id).is_err());
        assert_eq!(waiting.join().unwrap(), selected("allow"));
    }

    #[test]
    fn a_second_request_later_in_the_same_session_still_waits_for_an_answer() {
        let permissions = Arc::new(AcpPermissions::default());
        let (first, one) = queue(&permissions, request("s1", "first"));

        permissions.answer(first, "allow").unwrap();
        assert_eq!(one.join().unwrap(), selected("allow"));

        let (second, two) = queue(&permissions, request("s1", "second"));

        assert_eq!(permissions.view()[0].tool, "second");
        permissions.decline(second).unwrap();
        assert_eq!(two.join().unwrap(), selected("reject"));
    }

    #[test]
    fn approve_all_answers_exactly_the_requests_named_each_with_its_own_option() {
        let permissions = Arc::new(AcpPermissions::default());
        let mut other_option = request("s1", "second");
        other_option.options = vec![
            option("yes-this-one", ALLOW_ONCE),
            option("always-2", "allow_always"),
        ];
        let (a, first) = queue(&permissions, request("s1", "first"));
        let (b, second) = queue(&permissions, other_option);

        // The bar showed a and b. A third request arrives afterwards.
        let (c, third) = queue(&permissions, request("s1", "third"));
        let done = permissions.answer_batch(&[a, b]).unwrap();

        assert_eq!(done.len(), 2);
        assert!(done.iter().all(|answer| answer.decision == "once"));
        assert_eq!(first.join().unwrap(), selected("allow"));
        assert_eq!(second.join().unwrap(), selected("yes-this-one"));

        // The late one was not answered and prompts on its own.
        let view = permissions.view();

        assert_eq!(view.len(), 1);
        assert_eq!(view[0].id, c);

        permissions.answer(c, "allow").unwrap();
        assert_eq!(third.join().unwrap(), selected("allow"));
    }

    #[test]
    fn approve_all_remembers_nothing() {
        let permissions = Arc::new(AcpPermissions::default());
        let (a, first) = queue(&permissions, request("s1", "first"));

        permissions.answer_batch(&[a]).unwrap();
        first.join().unwrap();

        // The same tool asked again waits for a person again.
        let (_, again) = queue(&permissions, request("s1", "first"));

        assert_eq!(permissions.view().len(), 1);
        permissions.cancel_session("s1");
        assert_eq!(again.join().unwrap(), Outcome::Cancelled);
    }

    #[test]
    fn approve_all_is_refused_whole_when_one_request_cannot_be_batched() {
        let permissions = Arc::new(AcpPermissions::default());
        let mut partial = request("s1", "partial");
        partial.details_complete = false;
        let mut reject_only = request("s1", "reject only");
        reject_only.options = vec![option("reject", REJECT_ONCE)];
        let (a, first) = queue(&permissions, request("s1", "ok"));
        let (b, second) = queue(&permissions, partial);
        let (c, third) = queue(&permissions, reject_only);
        let (d, fourth) = queue(&permissions, request("s2", "other session"));

        assert!(!permissions.view()[1].batchable);
        assert!(!permissions.view()[2].batchable);

        for ids in [vec![a, b], vec![a, c], vec![a, d], vec![], vec![0; 51]] {
            assert!(permissions.answer_batch(&ids).is_err(), "{ids:?}");
        }

        // None was answered by the refused attempts.
        assert_eq!(permissions.view().len(), 4);

        permissions.cancel_session("s1");
        permissions.cancel_session("s2");
        for waiting in [first, second, third, fourth] {
            assert_eq!(waiting.join().unwrap(), Outcome::Cancelled);
        }
    }

    #[test]
    fn approve_all_skips_a_request_answered_meanwhile() {
        let permissions = Arc::new(AcpPermissions::default());
        let (a, first) = queue(&permissions, request("s1", "first"));
        let (b, second) = queue(&permissions, request("s1", "second"));

        permissions.decline(a).unwrap();

        let done = permissions.answer_batch(&[a, b]).unwrap();

        assert_eq!(done.len(), 1);
        assert_eq!(first.join().unwrap(), selected("reject"));
        assert_eq!(second.join().unwrap(), selected("allow"));
    }

    #[test]
    fn a_cancelled_session_answers_its_requests_cancelled_and_leaves_the_others() {
        let permissions = Arc::new(AcpPermissions::default());
        let (_, mine) = queue(&permissions, request("s1", "mine"));
        let (_, theirs) = queue(&permissions, request("s2", "theirs"));

        assert_eq!(permissions.cancel_session("s1"), 1);
        assert_eq!(mine.join().unwrap(), Outcome::Cancelled);
        assert_eq!(permissions.view().len(), 1);
        assert_eq!(permissions.view()[0].session_id, "s2");
        permissions.cancel_session("s2");
        theirs.join().unwrap();
    }

    #[test]
    fn closing_the_window_declines_everything_waiting() {
        let permissions = Arc::new(AcpPermissions::default());
        let (_, one) = queue(&permissions, request("s1", "one"));
        let (_, two) = queue(&permissions, request("s2", "two"));

        assert_eq!(permissions.decline_all().len(), 2);
        assert_eq!(one.join().unwrap(), selected("reject"));
        assert_eq!(two.join().unwrap(), selected("reject"));
        assert!(permissions.view().is_empty());
    }

    #[test]
    fn long_details_are_cut_and_can_no_longer_be_batched() {
        let permissions = Arc::new(AcpPermissions::default());
        let mut long = request("s1", "long");
        long.details = "x".repeat(MAX_DETAILS + 1);
        let (_, waiting) = queue(&permissions, long);
        let view = permissions.view();

        assert_eq!(view[0].details.len(), MAX_DETAILS);
        assert!(!view[0].details_complete && !view[0].batchable);
        permissions.cancel_session("s1");
        waiting.join().unwrap();
    }

    #[test]
    fn a_session_cannot_queue_more_than_its_share_and_the_rest_make_no_noise() {
        let permissions = Arc::new(AcpPermissions::default());
        let waiting: Vec<_> = (0..MAX_WAITING_PER_SESSION)
            .map(|n| queue(&permissions, request("s1", &format!("call {n}"))))
            .collect();
        let mut noisy = false;

        // Answered at once, on this thread, with no event for the window.
        let over = permissions.ask(request("s1", "one too many"), |_| noisy = true);

        assert_eq!(over, Outcome::Cancelled);
        assert!(!noisy);
        assert_eq!(permissions.view().len(), MAX_WAITING_PER_SESSION);

        // Another session is not affected, and answering frees a place.
        let (_, other) = queue(&permissions, request("s2", "other"));

        permissions.answer(waiting[0].0, "allow").unwrap();

        let (_, again) = queue(&permissions, request("s1", "fits again"));

        permissions.cancel_session("s1");
        permissions.cancel_session("s2");
        again.join().unwrap();
        other.join().unwrap();
        for (_, handle) in waiting {
            handle.join().unwrap();
        }
    }

    #[test]
    fn two_options_with_one_id_leave_nothing_to_approve() {
        let permissions = Arc::new(AcpPermissions::default());
        let mut clash = request("s1", "clash");
        clash.options = vec![
            option("x", ALLOW_ONCE),
            option("x", "allow_always"),
            option("reject", REJECT_ONCE),
        ];
        let (id, waiting) = queue(&permissions, clash);
        let view = permissions.view();

        assert!(view[0].options.is_empty() && !view[0].batchable);
        assert!(permissions.answer(id, "x").is_err());
        assert!(permissions.answer_batch(&[id]).is_err());

        permissions.decline(id).unwrap();
        assert_eq!(waiting.join().unwrap(), Outcome::Cancelled);
    }

    #[test]
    fn an_id_repeated_past_the_option_cap_still_leaves_nothing_to_approve() {
        let permissions = Arc::new(AcpPermissions::default());
        let mut clash = request("s1", "clash");

        clash.options = vec![option("x", ALLOW_ONCE)];
        clash
            .options
            .extend((0..MAX_OPTIONS).map(|n| option(&format!("filler-{n}"), "reject_always")));
        clash.options.push(option("x", "allow_always"));

        let (id, waiting) = queue(&permissions, clash);

        assert!(permissions.view()[0].options.is_empty());
        assert!(permissions.answer(id, "x").is_err());

        permissions.decline(id).unwrap();
        assert_eq!(waiting.join().unwrap(), Outcome::Cancelled);
    }

    #[test]
    fn the_outcome_has_the_shape_the_protocol_wants() {
        assert_eq!(
            serde_json::to_string(&selected("allow")).unwrap(),
            r#"{"outcome":"selected","optionId":"allow"}"#
        );
        assert_eq!(
            serde_json::to_string(&Outcome::Cancelled).unwrap(),
            r#"{"outcome":"cancelled"}"#
        );
    }
}
