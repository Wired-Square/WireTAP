// io/lifecycle.rs
//
// The terminal state a detached source task leaves behind.

use std::sync::{Arc, Mutex};

use super::IOState;

/// A slot a detached task stamps when it finishes, which the source's `state()`
/// reads through.
///
/// Every `IOSource` keeps a `state` field that `start` and `stop` maintain —
/// those are the transitions *we* drive. A source whose work runs on a detached
/// task has a third ending nobody calls it back for: the task returns. With
/// nowhere to record that, `state()` keeps answering `Running` for a sweep that
/// finished minutes ago, and the layers above compensate — Discovery's
/// poller-vs-sweep latch exists because `get_session_state` lied about a scan
/// session that had already ended.
///
/// The `Drop` guard is the point. A flag stored explicitly is a flag some future
/// early return forgets; a guard held by the task cannot be forgotten, and covers
/// a panic as well as a return.
///
/// The terminal state is a parameter because it differs: a reader is `Stopped`
/// when its loop exits, while a capture that played to its end is `Paused` at the
/// last frame.
#[derive(Clone, Default)]
pub struct SourceLifecycle {
    terminal: Arc<Mutex<Option<IOState>>>,
}

impl SourceLifecycle {
    pub fn new() -> Self {
        Self::default()
    }

    /// The guard a detached task holds for its lifetime. Bind it (`let _guard =
    /// …`), do not discard it with `let _ =`, which drops it immediately.
    ///
    /// Taking a guard *is* "a new run is starting", so this clears any previous
    /// ending rather than leaving that to a separate call the caller could
    /// forget — which would report a source as stopped for the whole of its
    /// second run.
    pub fn guard(&self, state: IOState) -> SourceLifecycleGuard {
        if let Ok(mut slot) = self.terminal.lock() {
            *slot = None;
        }
        SourceLifecycleGuard {
            terminal: self.terminal.clone(),
            state,
        }
    }

    /// `running` until the task has finished, then the state it finished in.
    pub fn state_or(&self, running: &IOState) -> IOState {
        self.terminal
            .lock()
            .ok()
            .and_then(|slot| slot.clone())
            .unwrap_or_else(|| running.clone())
    }
}

/// Stamps the terminal state when the task holding it goes away.
pub struct SourceLifecycleGuard {
    terminal: Arc<Mutex<Option<IOState>>>,
    state: IOState,
}

impl Drop for SourceLifecycleGuard {
    fn drop(&mut self) {
        if let Ok(mut slot) = self.terminal.lock() {
            *slot = Some(self.state.clone());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reports_the_running_state_until_the_task_ends() {
        let lifecycle = SourceLifecycle::new();
        let guard = lifecycle.guard(IOState::Stopped);
        assert_eq!(lifecycle.state_or(&IOState::Running), IOState::Running);
        drop(guard);
        assert_eq!(lifecycle.state_or(&IOState::Running), IOState::Stopped);
    }

    #[test]
    fn taking_a_guard_clears_the_previous_ending() {
        let lifecycle = SourceLifecycle::new();
        drop(lifecycle.guard(IOState::Stopped));
        let _second_run = lifecycle.guard(IOState::Stopped);
        assert_eq!(lifecycle.state_or(&IOState::Running), IOState::Running);
    }

    #[test]
    fn the_terminal_state_is_the_callers_choice() {
        let lifecycle = SourceLifecycle::new();
        drop(lifecycle.guard(IOState::Paused));
        assert_eq!(lifecycle.state_or(&IOState::Running), IOState::Paused);
    }
}
