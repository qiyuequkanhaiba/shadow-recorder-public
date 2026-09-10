pub fn reset_context_slot<T>(slot: &mut Option<T>) -> bool {
    if slot.is_some() {
        *slot = None;
        true
    } else {
        false
    }
}

pub fn reset_context_slot_with<T, OnCleared>(slot: &mut Option<T>, on_cleared: OnCleared) -> bool
where
    OnCleared: FnOnce(),
{
    if reset_context_slot(slot) {
        on_cleared();
        true
    } else {
        false
    }
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;

    use super::{reset_context_slot, reset_context_slot_with};

    #[test]
    fn reset_context_slot_clears_existing_context() {
        let mut slot = Some(123u32);
        let cleared = reset_context_slot(&mut slot);
        assert!(cleared);
        assert_eq!(slot, None);
    }

    #[test]
    fn reset_context_slot_skips_when_already_empty() {
        let mut slot: Option<u32> = None;
        let cleared = reset_context_slot(&mut slot);
        assert!(!cleared);
        assert_eq!(slot, None);
    }

    #[test]
    fn reset_context_slot_with_invokes_callback_only_when_cleared() {
        let callback_count = Cell::new(0u32);

        let mut present = Some(7u32);
        let cleared_present = reset_context_slot_with(&mut present, || {
            callback_count.set(callback_count.get().saturating_add(1));
        });

        let mut empty: Option<u32> = None;
        let cleared_empty = reset_context_slot_with(&mut empty, || {
            callback_count.set(callback_count.get().saturating_add(1));
        });

        assert!(cleared_present);
        assert!(!cleared_empty);
        assert_eq!(callback_count.get(), 1);
    }
}
