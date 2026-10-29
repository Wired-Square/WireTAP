//! Sync work called from async code: whole-file reads, serial port IO; and async
//! database work called from sync code.

use std::future::Future;
use std::sync::LazyLock;

/// Where a sync caller's database work runs: its own runtime, so the tasks an sqlx pool
/// spawns never wait on a worker the caller is blocking.
static RUNTIME: LazyLock<tokio::runtime::Runtime> = LazyLock::new(|| {
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(1)
        .thread_name("db-wait")
        .enable_all()
        .build()
        .expect("the database runtime starts")
});

/// Runs `work` to completion for a sync caller, on a scoped thread so a caller already
/// inside a runtime never nests one.
pub fn wait<F: Future + Send>(work: F) -> F::Output
where
    F::Output: Send,
{
    #[cfg(test)]
    let lent = crate::capture_db::LENT.with_borrow(Clone::clone);
    // A pooled connection returns on a task of the runtime that dropped it; hand this
    // worker's queue to the rest of the runtime so that task is not stuck behind us.
    in_place(|| {
        std::thread::scope(|scope| {
            scope
                .spawn(|| {
                    #[cfg(test)]
                    crate::capture_db::LENT.set(lent);
                    RUNTIME.block_on(work)
                })
                .join()
        })
    })
    .unwrap_or_else(|panic| std::panic::resume_unwind(panic))
}

/// Runs `work` on the blocking pool so a long query or file read never stalls the
/// async workers. A panic in `work` resumes in the caller, as it would inline.
pub async fn off_runtime<T: Send + 'static>(work: impl FnOnce() -> T + Send + 'static) -> T {
    match tauri::async_runtime::spawn_blocking(work).await {
        Ok(value) => value,
        Err(tauri::Error::JoinError(e)) if e.is_panic() => {
            std::panic::resume_unwind(e.into_panic())
        }
        Err(e) => panic!("blocking task failed: {e}"),
    }
}

/// Runs `work` inline for a sync caller that needs its result, first handing this
/// worker's other tasks to the rest of the runtime.
pub fn in_place<T>(work: impl FnOnce() -> T) -> T {
    use tokio::runtime::{Handle, RuntimeFlavor};
    match Handle::try_current() {
        Ok(runtime) if runtime.runtime_flavor() == RuntimeFlavor::MultiThread => {
            tokio::task::block_in_place(work)
        }
        _ => work(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn work_off_the_runtime_answers_on_another_thread() {
        let caller = std::thread::current().id();
        let worker = tauri::async_runtime::block_on(off_runtime(|| std::thread::current().id()));
        assert_ne!(worker, caller);
    }

    #[test]
    #[should_panic(expected = "panicked off the runtime")]
    fn a_panic_off_the_runtime_resumes_in_the_caller() {
        let () = tauri::async_runtime::block_on(off_runtime(|| panic!("panicked off the runtime")));
    }

    #[tokio::test]
    async fn work_in_place_runs_inline_on_a_current_thread_runtime() {
        let caller = std::thread::current().id();
        assert_eq!(in_place(|| std::thread::current().id()), caller);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn work_in_place_runs_on_a_multi_thread_worker() {
        assert_eq!(in_place(|| 7), 7);
    }
}
