use crate::metrics::RecorderMetrics;

#[derive(Clone, Copy)]
pub struct AdaptiveInputs {
    pub base_quality: f32,
    pub min_quality: f32,
    pub max_quality: f32,
    pub adaptive_enabled: bool,
    pub buffer_high_ratio: f32,
    pub buffer_low_ratio: f32,
    pub latency_high_ms: u32,
    pub latency_low_ms: u32,
    pub target_image_bytes: usize,
    pub step_down: f32,
    pub step_up: f32,
}

pub fn compute_effective_quality(
    metrics: &RecorderMetrics,
    inputs: AdaptiveInputs,
    buffer_usage_ratio: f32,
) -> (f32, bool, bool) {
    if !inputs.adaptive_enabled {
        return (
            inputs
                .base_quality
                .clamp(inputs.min_quality, inputs.max_quality),
            false,
            false,
        );
    }

    let mut quality = if metrics.current_effective_quality > 0.0 {
        metrics.current_effective_quality
    } else {
        inputs.base_quality
    };

    let mut decreased = false;
    let mut increased = false;

    let should_decrease = buffer_usage_ratio >= inputs.buffer_high_ratio
        || metrics.last_capture_latency_ms >= inputs.latency_high_ms
        || metrics.last_image_bytes as usize > inputs.target_image_bytes;
    let should_increase = buffer_usage_ratio <= inputs.buffer_low_ratio
        && metrics.last_capture_latency_ms <= inputs.latency_low_ms
        && (metrics.last_image_bytes as usize) <= inputs.target_image_bytes;

    if should_decrease {
        quality -= inputs.step_down;
        decreased = true;
    } else if should_increase {
        quality += inputs.step_up;
        increased = true;
    }

    quality = quality.clamp(inputs.min_quality, inputs.max_quality);
    (quality, decreased, increased)
}

#[cfg(test)]
mod tests {
    use super::{AdaptiveInputs, compute_effective_quality};
    use crate::metrics::RecorderMetrics;

    fn base_inputs() -> AdaptiveInputs {
        AdaptiveInputs {
            base_quality: 75.0,
            min_quality: 20.0,
            max_quality: 90.0,
            adaptive_enabled: true,
            buffer_high_ratio: 0.8,
            buffer_low_ratio: 0.5,
            latency_high_ms: 90,
            latency_low_ms: 45,
            target_image_bytes: 100 * 1024,
            step_down: 6.0,
            step_up: 2.0,
        }
    }

    #[test]
    fn adaptive_quality_decreases_under_pressure() {
        let metrics = RecorderMetrics {
            current_effective_quality: 70.0,
            last_capture_latency_ms: 120,
            last_image_bytes: 180 * 1024,
            ..RecorderMetrics::default()
        };

        let (quality, down, up) = compute_effective_quality(&metrics, base_inputs(), 0.82);
        assert!(down);
        assert!(!up);
        assert!(quality < 70.0);
    }

    #[test]
    fn adaptive_quality_increases_when_stable() {
        let metrics = RecorderMetrics {
            current_effective_quality: 60.0,
            last_capture_latency_ms: 30,
            last_image_bytes: 40 * 1024,
            ..RecorderMetrics::default()
        };

        let (quality, down, up) = compute_effective_quality(&metrics, base_inputs(), 0.2);
        assert!(!down);
        assert!(up);
        assert!(quality > 60.0);
    }

    #[test]
    fn adaptive_quality_respects_bounds_when_disabled() {
        let metrics = RecorderMetrics {
            current_effective_quality: 88.0,
            ..RecorderMetrics::default()
        };

        let mut inputs = base_inputs();
        inputs.adaptive_enabled = false;
        inputs.base_quality = 95.0;

        let (quality, down, up) = compute_effective_quality(&metrics, inputs, 0.9);
        assert_eq!(quality, 90.0);
        assert!(!down);
        assert!(!up);
    }
}
