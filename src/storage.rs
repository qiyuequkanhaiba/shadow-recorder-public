use std::collections::VecDeque;

use crate::types::StepData;

#[derive(Debug, Default, Clone)]
pub struct RingBuffer {
    items: VecDeque<StepData>,
    total_bytes: usize,
}

impl RingBuffer {
    pub fn with_capacity(capacity: usize) -> Self {
        Self {
            items: VecDeque::with_capacity(capacity),
            total_bytes: 0,
        }
    }

    pub fn clear(&mut self) {
        self.items.clear();
        self.total_bytes = 0;
    }

    pub fn len(&self) -> usize {
        self.items.len()
    }

    pub fn total_bytes(&self) -> usize {
        self.total_bytes
    }

    pub fn to_vec(&self) -> Vec<StepData> {
        self.items.iter().cloned().collect()
    }

    pub fn to_vec_since(&self, last_id: u64) -> Vec<StepData> {
        self.items
            .iter()
            .filter(|step| step.id > last_id)
            .cloned()
            .collect()
    }

    pub fn to_vec_page_since(&self, cursor: u64, limit: usize) -> Vec<StepData> {
        let take = limit.max(1);
        self.items
            .iter()
            .filter(|step| step.id > cursor)
            .take(take)
            .cloned()
            .collect()
    }

    pub fn find_by_id(&self, step_id: u64) -> Option<StepData> {
        self.items.iter().find(|step| step.id == step_id).cloned()
    }

    pub fn push_and_trim(&mut self, step: StepData, max_steps: usize, max_buffer_bytes: usize) {
        self.total_bytes = self.total_bytes.saturating_add(step.storage_bytes());
        self.items.push_back(step);

        while self.items.len() > max_steps {
            self.pop_front();
        }

        while self.total_bytes > max_buffer_bytes && !self.items.is_empty() {
            self.pop_front();
        }
    }

    pub fn trim_to_limits(&mut self, max_steps: usize, max_buffer_bytes: usize) {
        while self.items.len() > max_steps {
            self.pop_front();
        }

        while self.total_bytes > max_buffer_bytes && !self.items.is_empty() {
            self.pop_front();
        }
    }

    fn pop_front(&mut self) {
        if let Some(removed) = self.items.pop_front() {
            self.total_bytes = self.total_bytes.saturating_sub(removed.storage_bytes());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::RingBuffer;
    use crate::types::{CaptureBackendUsed, StepData, StepSource};

    fn fake_step(id: u64, bytes: usize) -> StepData {
        StepData {
            id,
            timestamp_ms: id,
            action: "WM_LBUTTONDOWN".to_string(),
            x: 1,
            y: 1,
            logical_x: 1,
            logical_y: 1,
            window_left: 0,
            window_top: 0,
            window_right: 10,
            window_bottom: 10,
            logical_window_left: 0,
            logical_window_top: 0,
            logical_window_right: 10,
            logical_window_bottom: 10,
            display_id: "monitor-0x1".to_string(),
            dpi_scale: 1.0,
            process_name: "test.exe".to_string(),
            window_title: "window".to_string(),
            image_webp: vec![0u8; bytes],
            image_thumb_webp: Vec::new(),
            image_bytes: bytes,
            capture_latency_ms: 1,
            encode_latency_ms: 1,
            source: StepSource::Hook,
            capture_backend: CaptureBackendUsed::Dxgi,
        }
    }

    #[test]
    fn push_and_trim_respects_step_limit() {
        let mut buffer = RingBuffer::with_capacity(2);
        buffer.push_and_trim(fake_step(1, 100), 2, 10_000);
        buffer.push_and_trim(fake_step(2, 100), 2, 10_000);
        buffer.push_and_trim(fake_step(3, 100), 2, 10_000);

        let steps = buffer.to_vec();
        assert_eq!(steps.len(), 2);
        assert_eq!(steps[0].id, 2);
        assert_eq!(steps[1].id, 3);
    }

    #[test]
    fn push_and_trim_respects_byte_limit() {
        let mut buffer = RingBuffer::with_capacity(3);
        buffer.push_and_trim(fake_step(1, 120), 3, 250);
        buffer.push_and_trim(fake_step(2, 120), 3, 250);
        buffer.push_and_trim(fake_step(3, 120), 3, 250);

        let steps = buffer.to_vec();
        assert_eq!(steps.len(), 2);
        assert_eq!(steps[0].id, 2);
        assert_eq!(steps[1].id, 3);
        assert!(buffer.total_bytes() <= 250);
    }

    #[test]
    fn to_vec_since_returns_only_newer_steps() {
        let mut buffer = RingBuffer::with_capacity(4);
        buffer.push_and_trim(fake_step(10, 100), 4, 10_000);
        buffer.push_and_trim(fake_step(11, 100), 4, 10_000);
        buffer.push_and_trim(fake_step(12, 100), 4, 10_000);

        let steps = buffer.to_vec_since(10);
        assert_eq!(steps.len(), 2);
        assert_eq!(steps[0].id, 11);
        assert_eq!(steps[1].id, 12);
    }

    #[test]
    fn to_vec_since_returns_empty_when_no_new_steps() {
        let mut buffer = RingBuffer::with_capacity(2);
        buffer.push_and_trim(fake_step(3, 100), 2, 10_000);
        buffer.push_and_trim(fake_step(4, 100), 2, 10_000);

        let steps = buffer.to_vec_since(4);
        assert!(steps.is_empty());
    }
}
