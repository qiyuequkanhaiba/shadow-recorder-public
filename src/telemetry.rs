use std::sync::atomic::{AtomicBool, AtomicU8, AtomicU32, AtomicU64, Ordering};

pub static INPUT_CHANNEL_FULL_DROP_TOTAL: AtomicU64 = AtomicU64::new(0);
pub static BACKEND_FALLBACK_TOTAL: AtomicU64 = AtomicU64::new(0);
pub static CAPTURE_CONTEXT_RESET_TOTAL: AtomicU64 = AtomicU64::new(0);
pub static EFFECTIVE_INPUT_MODE: AtomicU8 = AtomicU8::new(0);
pub static CAPTURE_QUEUE_DROP_TOTAL: AtomicU64 = AtomicU64::new(0);
pub static ENCODE_QUEUE_DROP_TOTAL: AtomicU64 = AtomicU64::new(0);
pub static UIA_OBSERVER_QUEUE_DEPTH: AtomicU32 = AtomicU32::new(0);
pub static UIA_OBSERVER_DROPPED_TOTAL: AtomicU64 = AtomicU64::new(0);
pub static UIA_OBSERVER_DUPLICATE_DROP_TOTAL: AtomicU64 = AtomicU64::new(0);
pub static UIA_OBSERVER_RATE_LIMIT_DROP_TOTAL: AtomicU64 = AtomicU64::new(0);
pub static UIA_OBSERVER_QUEUE_OVERFLOW_TOTAL: AtomicU64 = AtomicU64::new(0);
pub static UIA_OBSERVER_TIMEOUT_TOTAL: AtomicU64 = AtomicU64::new(0);
pub static UIA_OBSERVER_RESTART_TOTAL: AtomicU64 = AtomicU64::new(0);
pub static UIA_OBSERVER_POLLING_ATTEMPT_TOTAL: AtomicU64 = AtomicU64::new(0);
pub static UIA_OBSERVER_CIRCUIT_OPEN: AtomicBool = AtomicBool::new(false);

pub fn inc_input_channel_full_drop() {
    let _ = INPUT_CHANNEL_FULL_DROP_TOTAL.fetch_add(1, Ordering::Relaxed);
}

pub fn read_input_channel_full_drop_total() -> u64 {
    INPUT_CHANNEL_FULL_DROP_TOTAL.load(Ordering::Relaxed)
}

pub fn inc_capture_queue_drop() {
    let _ = CAPTURE_QUEUE_DROP_TOTAL.fetch_add(1, Ordering::Relaxed);
}

pub fn read_capture_queue_drop_total() -> u64 {
    CAPTURE_QUEUE_DROP_TOTAL.load(Ordering::Relaxed)
}

pub fn inc_encode_queue_drop() {
    let _ = ENCODE_QUEUE_DROP_TOTAL.fetch_add(1, Ordering::Relaxed);
}

pub fn read_encode_queue_drop_total() -> u64 {
    ENCODE_QUEUE_DROP_TOTAL.load(Ordering::Relaxed)
}

pub fn set_uia_observer_queue_depth(value: u32) {
    UIA_OBSERVER_QUEUE_DEPTH.store(value, Ordering::Relaxed);
}

pub fn read_uia_observer_queue_depth() -> u32 {
    UIA_OBSERVER_QUEUE_DEPTH.load(Ordering::Relaxed)
}

pub fn inc_uia_observer_dropped() {
    let _ = UIA_OBSERVER_DROPPED_TOTAL.fetch_add(1, Ordering::Relaxed);
}

pub fn read_uia_observer_dropped_total() -> u64 {
    UIA_OBSERVER_DROPPED_TOTAL.load(Ordering::Relaxed)
}

pub fn inc_uia_observer_duplicate_drop() {
    let _ = UIA_OBSERVER_DUPLICATE_DROP_TOTAL.fetch_add(1, Ordering::Relaxed);
}

pub fn read_uia_observer_duplicate_drop_total() -> u64 {
    UIA_OBSERVER_DUPLICATE_DROP_TOTAL.load(Ordering::Relaxed)
}

pub fn inc_uia_observer_rate_limit_drop() {
    let _ = UIA_OBSERVER_RATE_LIMIT_DROP_TOTAL.fetch_add(1, Ordering::Relaxed);
}

pub fn read_uia_observer_rate_limit_drop_total() -> u64 {
    UIA_OBSERVER_RATE_LIMIT_DROP_TOTAL.load(Ordering::Relaxed)
}

pub fn inc_uia_observer_queue_overflow() {
    let _ = UIA_OBSERVER_QUEUE_OVERFLOW_TOTAL.fetch_add(1, Ordering::Relaxed);
}

pub fn read_uia_observer_queue_overflow_total() -> u64 {
    UIA_OBSERVER_QUEUE_OVERFLOW_TOTAL.load(Ordering::Relaxed)
}

pub fn inc_uia_observer_timeout() {
    let _ = UIA_OBSERVER_TIMEOUT_TOTAL.fetch_add(1, Ordering::Relaxed);
}

pub fn read_uia_observer_timeout_total() -> u64 {
    UIA_OBSERVER_TIMEOUT_TOTAL.load(Ordering::Relaxed)
}

pub fn inc_uia_observer_restart() {
    let _ = UIA_OBSERVER_RESTART_TOTAL.fetch_add(1, Ordering::Relaxed);
}

pub fn read_uia_observer_restart_total() -> u64 {
    UIA_OBSERVER_RESTART_TOTAL.load(Ordering::Relaxed)
}

pub fn inc_uia_observer_polling_attempt() {
    let _ = UIA_OBSERVER_POLLING_ATTEMPT_TOTAL.fetch_add(1, Ordering::Relaxed);
}

pub fn read_uia_observer_polling_attempt_total() -> u64 {
    UIA_OBSERVER_POLLING_ATTEMPT_TOTAL.load(Ordering::Relaxed)
}

pub fn set_uia_observer_circuit_open(open: bool) {
    UIA_OBSERVER_CIRCUIT_OPEN.store(open, Ordering::Relaxed);
}

pub fn read_uia_observer_circuit_open() -> bool {
    UIA_OBSERVER_CIRCUIT_OPEN.load(Ordering::Relaxed)
}

pub fn inc_backend_fallback() {
    let _ = BACKEND_FALLBACK_TOTAL.fetch_add(1, Ordering::Relaxed);
}

pub fn read_backend_fallback_total() -> u64 {
    BACKEND_FALLBACK_TOTAL.load(Ordering::Relaxed)
}

pub fn inc_capture_context_reset() {
    let _ = CAPTURE_CONTEXT_RESET_TOTAL.fetch_add(1, Ordering::Relaxed);
}

pub fn read_capture_context_reset_total() -> u64 {
    CAPTURE_CONTEXT_RESET_TOTAL.load(Ordering::Relaxed)
}

pub fn set_effective_input_mode_hook() {
    EFFECTIVE_INPUT_MODE.store(0, Ordering::Relaxed);
}

pub fn set_effective_input_mode_raw_input() {
    EFFECTIVE_INPUT_MODE.store(1, Ordering::Relaxed);
}

pub fn read_effective_input_mode() -> &'static str {
    if EFFECTIVE_INPUT_MODE.load(Ordering::Relaxed) == 1 {
        "raw_input"
    } else {
        "hook"
    }
}

#[cfg(test)]
mod tests {
    use super::{
        inc_backend_fallback, inc_capture_context_reset, inc_capture_queue_drop,
        inc_encode_queue_drop, inc_input_channel_full_drop, inc_uia_observer_dropped,
        inc_uia_observer_duplicate_drop, inc_uia_observer_polling_attempt,
        inc_uia_observer_queue_overflow, inc_uia_observer_rate_limit_drop,
        inc_uia_observer_restart, inc_uia_observer_timeout, read_backend_fallback_total,
        read_capture_context_reset_total, read_capture_queue_drop_total, read_effective_input_mode,
        read_encode_queue_drop_total, read_input_channel_full_drop_total,
        read_uia_observer_circuit_open, read_uia_observer_dropped_total,
        read_uia_observer_duplicate_drop_total, read_uia_observer_polling_attempt_total,
        read_uia_observer_queue_depth, read_uia_observer_queue_overflow_total,
        read_uia_observer_rate_limit_drop_total, read_uia_observer_restart_total,
        read_uia_observer_timeout_total, set_effective_input_mode_hook,
        set_effective_input_mode_raw_input, set_uia_observer_circuit_open,
        set_uia_observer_queue_depth,
    };

    #[test]
    fn input_channel_drop_counter_increments_monotonically() {
        let before = read_input_channel_full_drop_total();
        inc_input_channel_full_drop();
        let after = read_input_channel_full_drop_total();
        assert!(after >= before.saturating_add(1));
    }

    #[test]
    fn backend_fallback_counter_increments_monotonically() {
        let before = read_backend_fallback_total();
        inc_backend_fallback();
        let after = read_backend_fallback_total();
        assert!(after >= before.saturating_add(1));
    }

    #[test]
    fn capture_context_reset_counter_increments_monotonically() {
        let before = read_capture_context_reset_total();
        inc_capture_context_reset();
        let after = read_capture_context_reset_total();
        assert!(after >= before.saturating_add(1));
    }

    #[test]
    fn capture_queue_drop_counter_increments_monotonically() {
        let before = read_capture_queue_drop_total();
        inc_capture_queue_drop();
        let after = read_capture_queue_drop_total();
        assert!(after >= before.saturating_add(1));
    }

    #[test]
    fn encode_queue_drop_counter_increments_monotonically() {
        let before = read_encode_queue_drop_total();
        inc_encode_queue_drop();
        let after = read_encode_queue_drop_total();
        assert!(after >= before.saturating_add(1));
    }

    #[test]
    fn uia_observer_counters_are_exposed() {
        let before_dropped = read_uia_observer_dropped_total();
        let before_duplicate = read_uia_observer_duplicate_drop_total();
        let before_rate = read_uia_observer_rate_limit_drop_total();
        let before_overflow = read_uia_observer_queue_overflow_total();
        let before_timeout = read_uia_observer_timeout_total();
        let before_restart = read_uia_observer_restart_total();
        let before_polling = read_uia_observer_polling_attempt_total();

        set_uia_observer_queue_depth(42);
        inc_uia_observer_dropped();
        inc_uia_observer_duplicate_drop();
        inc_uia_observer_rate_limit_drop();
        inc_uia_observer_queue_overflow();
        inc_uia_observer_timeout();
        inc_uia_observer_restart();
        inc_uia_observer_polling_attempt();
        set_uia_observer_circuit_open(true);

        assert_eq!(read_uia_observer_queue_depth(), 42);
        assert!(read_uia_observer_dropped_total() >= before_dropped.saturating_add(1));
        assert!(read_uia_observer_duplicate_drop_total() >= before_duplicate.saturating_add(1));
        assert!(read_uia_observer_rate_limit_drop_total() >= before_rate.saturating_add(1));
        assert!(read_uia_observer_queue_overflow_total() >= before_overflow.saturating_add(1));
        assert!(read_uia_observer_timeout_total() >= before_timeout.saturating_add(1));
        assert!(read_uia_observer_restart_total() >= before_restart.saturating_add(1));
        assert!(read_uia_observer_polling_attempt_total() >= before_polling.saturating_add(1));
        assert!(read_uia_observer_circuit_open());

        set_uia_observer_circuit_open(false);
    }

    #[test]
    fn effective_input_mode_switches_between_backends() {
        set_effective_input_mode_hook();
        assert_eq!(read_effective_input_mode(), "hook");

        set_effective_input_mode_raw_input();
        assert_eq!(read_effective_input_mode(), "raw_input");

        set_effective_input_mode_hook();
        assert_eq!(read_effective_input_mode(), "hook");
    }
}
