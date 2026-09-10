use crate::config::CaptureBackendMode;
use crate::error::RecorderError;
use crate::types::CaptureBackendUsed;

pub fn capture_with_backend_policy<T, CaptureWgc, CaptureDxgi>(
    capture_backend: CaptureBackendMode,
    strict_backend: bool,
    capture_wgc: CaptureWgc,
    capture_dxgi: CaptureDxgi,
) -> (Result<(T, CaptureBackendUsed), RecorderError>, bool)
where
    CaptureWgc: FnOnce() -> Result<T, RecorderError>,
    CaptureDxgi: FnOnce() -> Result<T, RecorderError>,
{
    match capture_backend {
        CaptureBackendMode::Dxgi => (
            capture_dxgi().map(|output| (output, CaptureBackendUsed::Dxgi)),
            false,
        ),
        CaptureBackendMode::Wgc => match capture_wgc() {
            Ok(output) => (Ok((output, CaptureBackendUsed::Wgc)), false),
            Err(err) => {
                if strict_backend {
                    (Err(err), false)
                } else {
                    (
                        capture_dxgi().map(|output| (output, CaptureBackendUsed::Dxgi)),
                        true,
                    )
                }
            }
        },
        CaptureBackendMode::Auto => match capture_wgc() {
            Ok(output) => (Ok((output, CaptureBackendUsed::Wgc)), false),
            Err(_) => (
                capture_dxgi().map(|output| (output, CaptureBackendUsed::Dxgi)),
                true,
            ),
        },
    }
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;

    use super::capture_with_backend_policy;
    use crate::config::CaptureBackendMode;
    use crate::error::RecorderError;
    use crate::types::CaptureBackendUsed;

    #[test]
    fn capture_policy_uses_dxgi_only_when_forced_dxgi() {
        let wgc_called = Cell::new(0u32);
        let dxgi_called = Cell::new(0u32);
        let (result, fallback_attempted) = capture_with_backend_policy(
            CaptureBackendMode::Dxgi,
            false,
            || {
                wgc_called.set(wgc_called.get().saturating_add(1));
                Ok(1u32)
            },
            || {
                dxgi_called.set(dxgi_called.get().saturating_add(1));
                Ok(2u32)
            },
        );

        assert!(!fallback_attempted);
        assert_eq!(wgc_called.get(), 0);
        assert_eq!(dxgi_called.get(), 1);

        let (payload, backend) = result.expect("forced dxgi should succeed");
        assert_eq!(payload, 2u32);
        assert_eq!(backend, CaptureBackendUsed::Dxgi);
    }

    #[test]
    fn capture_policy_prefers_wgc_when_auto_and_wgc_succeeds() {
        let wgc_called = Cell::new(0u32);
        let dxgi_called = Cell::new(0u32);
        let (result, fallback_attempted) = capture_with_backend_policy(
            CaptureBackendMode::Auto,
            false,
            || {
                wgc_called.set(wgc_called.get().saturating_add(1));
                Ok(7u32)
            },
            || {
                dxgi_called.set(dxgi_called.get().saturating_add(1));
                Ok(9u32)
            },
        );

        assert!(!fallback_attempted);
        assert_eq!(wgc_called.get(), 1);
        assert_eq!(dxgi_called.get(), 0);

        let (payload, backend) = result.expect("auto mode should use wgc when available");
        assert_eq!(payload, 7u32);
        assert_eq!(backend, CaptureBackendUsed::Wgc);
    }

    #[test]
    fn capture_policy_attempts_fallback_when_auto_wgc_fails() {
        let (result, fallback_attempted) = capture_with_backend_policy(
            CaptureBackendMode::Auto,
            false,
            || {
                Err::<u32, RecorderError>(RecorderError::DxgiCaptureFailed(
                    "wgc failed".to_string(),
                ))
            },
            || Ok(11u32),
        );

        assert!(fallback_attempted);
        let (payload, backend) = result.expect("auto mode should fallback to dxgi");
        assert_eq!(payload, 11u32);
        assert_eq!(backend, CaptureBackendUsed::Dxgi);
    }

    #[test]
    fn capture_policy_attempts_fallback_when_forced_wgc_fails() {
        let (result, fallback_attempted) = capture_with_backend_policy(
            CaptureBackendMode::Wgc,
            false,
            || {
                Err::<u32, RecorderError>(RecorderError::DxgiCaptureFailed(
                    "wgc failed".to_string(),
                ))
            },
            || Ok(13u32),
        );

        assert!(fallback_attempted);
        let (payload, backend) =
            result.expect("forced wgc mode should keep compatibility fallback");
        assert_eq!(payload, 13u32);
        assert_eq!(backend, CaptureBackendUsed::Dxgi);
    }

    #[test]
    fn capture_policy_surfaces_dxgi_error_after_fallback_attempt() {
        let (result, fallback_attempted) = capture_with_backend_policy(
            CaptureBackendMode::Auto,
            false,
            || {
                Err::<u32, RecorderError>(RecorderError::DxgiCaptureFailed(
                    "wgc failed".to_string(),
                ))
            },
            || {
                Err::<u32, RecorderError>(RecorderError::DxgiCaptureFailed(
                    "dxgi failed".to_string(),
                ))
            },
        );

        assert!(fallback_attempted);
        assert!(matches!(result, Err(RecorderError::DxgiCaptureFailed(_))));
    }

    #[test]
    fn capture_policy_respects_strict_backend_for_forced_wgc() {
        let (result, fallback_attempted) = capture_with_backend_policy(
            CaptureBackendMode::Wgc,
            true,
            || {
                Err::<u32, RecorderError>(RecorderError::DxgiCaptureFailed(
                    "wgc failed".to_string(),
                ))
            },
            || Ok(13u32),
        );

        assert!(!fallback_attempted);
        assert!(matches!(result, Err(RecorderError::DxgiCaptureFailed(_))));
    }
}
