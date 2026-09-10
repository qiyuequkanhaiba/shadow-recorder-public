use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, mpsc};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use crossbeam_channel::Sender;

use crate::config::InputMode;
use crate::error::RecorderError;
use crate::hooks::{MouseEvent, run_hook_thread};
use crate::raw_input::run_raw_input_thread;
use crate::telemetry::{
    read_input_channel_full_drop_total, set_effective_input_mode_hook,
    set_effective_input_mode_raw_input,
};

const AUTO_MONITOR_INTERVAL: Duration = Duration::from_millis(200);
const AUTO_SWITCH_TO_RAW_DROP_DELTA: u64 = 4;
const AUTO_SWITCH_BACK_STABLE_TICKS: u32 = 3;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum ActiveBackend {
    Hook,
    RawInput,
}

fn evaluate_auto_switch(
    backend: ActiveBackend,
    drop_delta: u64,
    stable_ticks: u32,
) -> (Option<ActiveBackend>, u32) {
    if backend == ActiveBackend::Hook {
        if drop_delta >= AUTO_SWITCH_TO_RAW_DROP_DELTA {
            return (Some(ActiveBackend::RawInput), 0);
        }
        return (None, stable_ticks);
    }

    let next_stable_ticks = if drop_delta == 0 {
        stable_ticks.saturating_add(1)
    } else {
        0
    };
    if next_stable_ticks >= AUTO_SWITCH_BACK_STABLE_TICKS {
        return (Some(ActiveBackend::Hook), 0);
    }
    (None, next_stable_ticks)
}

fn spawn_backend(
    backend: ActiveBackend,
    stop: Arc<AtomicBool>,
    sender: Sender<MouseEvent>,
    debounce_ms: u64,
) -> Result<JoinHandle<()>, RecorderError> {
    match backend {
        ActiveBackend::Hook => {
            let handle = run_hook_thread(stop, sender, debounce_ms)?;
            set_effective_input_mode_hook();
            Ok(handle)
        }
        ActiveBackend::RawInput => {
            let handle = run_raw_input_thread(stop, sender, debounce_ms)?;
            set_effective_input_mode_raw_input();
            Ok(handle)
        }
    }
}

fn run_auto_input_thread(
    recorder_stop: Arc<AtomicBool>,
    sender: Sender<MouseEvent>,
    debounce_ms: u64,
) -> Result<JoinHandle<()>, RecorderError> {
    let (ready_tx, ready_rx) = mpsc::channel::<Result<(), RecorderError>>();
    let handle = thread::Builder::new()
        .name("shadow-recorder-input-auto".to_string())
        .spawn(move || {
            let mut backend = ActiveBackend::RawInput;
            let mut backend_stop = Arc::new(AtomicBool::new(false));
            let mut backend_handle: Option<JoinHandle<()>> = match spawn_backend(
                backend,
                Arc::clone(&backend_stop),
                sender.clone(),
                debounce_ms,
            ) {
                Ok(handle) => {
                    let _ = ready_tx.send(Ok(()));
                    Some(handle)
                }
                Err(_) => {
                    backend = ActiveBackend::Hook;
                    match spawn_backend(
                        backend,
                        Arc::clone(&backend_stop),
                        sender.clone(),
                        debounce_ms,
                    ) {
                        Ok(handle) => {
                            let _ = ready_tx.send(Ok(()));
                            Some(handle)
                        }
                        Err(err) => {
                            let _ = ready_tx.send(Err(err));
                            return;
                        }
                    }
                }
            };

            let mut last_drop_total = read_input_channel_full_drop_total();
            let mut stable_ticks = 0u32;

            while !recorder_stop.load(Ordering::SeqCst) {
                thread::sleep(AUTO_MONITOR_INTERVAL);
                if recorder_stop.load(Ordering::SeqCst) {
                    break;
                }

                let current_drop_total = read_input_channel_full_drop_total();
                let drop_delta = current_drop_total.saturating_sub(last_drop_total);
                last_drop_total = current_drop_total;

                let (target, next_stable_ticks) =
                    evaluate_auto_switch(backend, drop_delta, stable_ticks);
                stable_ticks = next_stable_ticks;

                if let Some(next_backend) = target {
                    backend_stop.store(true, Ordering::SeqCst);
                    if let Some(handle) = backend_handle.take() {
                        let _ = handle.join();
                    }

                    let next_stop = Arc::new(AtomicBool::new(false));
                    match spawn_backend(
                        next_backend,
                        Arc::clone(&next_stop),
                        sender.clone(),
                        debounce_ms,
                    ) {
                        Ok(next_handle) => {
                            backend = next_backend;
                            backend_stop = next_stop;
                            backend_handle = Some(next_handle);
                        }
                        Err(_) => {
                            let fallback = if next_backend == ActiveBackend::Hook {
                                ActiveBackend::RawInput
                            } else {
                                ActiveBackend::Hook
                            };
                            match spawn_backend(
                                fallback,
                                Arc::clone(&next_stop),
                                sender.clone(),
                                debounce_ms,
                            ) {
                                Ok(next_handle) => {
                                    backend = fallback;
                                    backend_stop = next_stop;
                                    backend_handle = Some(next_handle);
                                }
                                Err(_) => break,
                            }
                        }
                    }
                }
            }

            backend_stop.store(true, Ordering::SeqCst);
            if let Some(handle) = backend_handle.take() {
                let _ = handle.join();
            }
        })
        .map_err(|_| RecorderError::ThreadStartFailed)?;

    match ready_rx.recv() {
        Ok(Ok(())) => Ok(handle),
        Ok(Err(err)) => {
            let _ = handle.join();
            Err(err)
        }
        Err(_) => {
            let _ = handle.join();
            Err(RecorderError::ThreadStartFailed)
        }
    }
}

pub fn run_input_thread(
    stop: Arc<AtomicBool>,
    sender: Sender<MouseEvent>,
    debounce_ms: u64,
    input_mode: InputMode,
) -> Result<JoinHandle<()>, RecorderError> {
    match input_mode {
        InputMode::RawInput => {
            set_effective_input_mode_raw_input();
            run_raw_input_thread(stop, sender, debounce_ms)
        }
        InputMode::Hook => {
            set_effective_input_mode_hook();
            run_hook_thread(stop, sender, debounce_ms)
        }
        InputMode::Auto => run_auto_input_thread(stop, sender, debounce_ms),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        AUTO_SWITCH_BACK_STABLE_TICKS, AUTO_SWITCH_TO_RAW_DROP_DELTA, ActiveBackend,
        evaluate_auto_switch,
    };

    #[test]
    fn auto_switches_from_hook_to_raw_when_drop_delta_crosses_threshold() {
        let (target, stable_ticks) =
            evaluate_auto_switch(ActiveBackend::Hook, AUTO_SWITCH_TO_RAW_DROP_DELTA, 0);
        assert_eq!(target, Some(ActiveBackend::RawInput));
        assert_eq!(stable_ticks, 0);
    }

    #[test]
    fn auto_keeps_hook_when_drop_delta_is_below_threshold() {
        let (target, stable_ticks) =
            evaluate_auto_switch(ActiveBackend::Hook, AUTO_SWITCH_TO_RAW_DROP_DELTA - 1, 2);
        assert_eq!(target, None);
        assert_eq!(stable_ticks, 2);
    }

    #[test]
    fn auto_switches_back_to_hook_after_required_stable_ticks() {
        let mut stable_ticks = 0u32;
        let mut target = None;
        for _ in 0..AUTO_SWITCH_BACK_STABLE_TICKS {
            let next = evaluate_auto_switch(ActiveBackend::RawInput, 0, stable_ticks);
            target = next.0;
            stable_ticks = next.1;
        }
        assert_eq!(target, Some(ActiveBackend::Hook));
        assert_eq!(stable_ticks, 0);
    }

    #[test]
    fn auto_resets_stable_ticks_on_new_drop_while_raw_input_active() {
        let (target, stable_ticks) = evaluate_auto_switch(ActiveBackend::RawInput, 2, 2);
        assert_eq!(target, None);
        assert_eq!(stable_ticks, 0);
    }
}
