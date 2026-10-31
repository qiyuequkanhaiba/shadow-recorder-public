//! Free-space checks for recording start, the in-recording stop, and defect export.
//!
//! Windows uses GetDiskFreeSpaceExW (bytes available to the caller). Start, the
//! 30-second watch, and export all decide whether native code may write, so the
//! query lives here instead of Electron's fs.statfs.

use std::cell::RefCell;
use std::io;
use std::path::{Path, PathBuf};

pub const MIN_FREE_BYTES_TO_START: u64 = 2 * 1024 * 1024 * 1024;
/// Enforced by the Electron 30-second watch. Rust tests cover the same predicate.
#[cfg_attr(not(test), allow(dead_code))]
pub const MIN_FREE_BYTES_WHILE_RECORDING: u64 = 1024 * 1024 * 1024;

thread_local! {
    static FREE_BYTES_OVERRIDE: RefCell<Option<u64>> = const { RefCell::new(None) };
}

#[cfg_attr(not(test), allow(dead_code))]
pub fn set_free_bytes_override_for_test(value: Option<u64>) {
    FREE_BYTES_OVERRIDE.with(|slot| *slot.borrow_mut() = value);
}

pub fn can_start_recording(free_bytes: u64, min_free_bytes: u64) -> bool {
    free_bytes >= min_free_bytes
}

#[cfg_attr(not(test), allow(dead_code))]
pub fn should_stop_for_disk(free_bytes: u64, min_free_bytes: u64) -> bool {
    free_bytes < min_free_bytes
}

pub fn estimated_export_bytes(source_bytes: u64) -> u64 {
    source_bytes.saturating_mul(6) / 5
}

pub fn can_export(free_bytes: u64, source_bytes: u64) -> bool {
    free_bytes >= estimated_export_bytes(source_bytes)
}

pub fn threshold_bytes(value: Option<f64>, default_bytes: u64) -> u64 {
    let Some(value) = value else {
        return default_bytes;
    };
    if !value.is_finite() || value < 0.0 {
        return default_bytes;
    }
    if value >= u64::MAX as f64 {
        return u64::MAX;
    }
    value.round() as u64
}

pub fn format_gib(bytes: u64) -> String {
    let gib = (bytes as f64) / 1024.0 / 1024.0 / 1024.0;
    format!("{gib:.1}")
}

pub fn start_refused_message(min_bytes: u64) -> String {
    format!(
        "磁盘剩余空间不足，无法开始录制（至少需要 {} GiB）",
        format_gib(min_bytes)
    )
}

pub fn export_refused_message(needed_bytes: u64) -> String {
    format!(
        "磁盘剩余空间不足，无法导出（至少需要 {} GiB）",
        format_gib(needed_bytes)
    )
}

pub fn disk_free_bytes(path: &Path) -> io::Result<u64> {
    if let Some(value) = FREE_BYTES_OVERRIDE.with(|slot| *slot.borrow()) {
        return Ok(value);
    }
    platform_disk_free_bytes(path)
}

fn existing_ancestor(path: &Path) -> Option<PathBuf> {
    let mut current = path.to_path_buf();
    loop {
        if current.as_os_str().is_empty() {
            return None;
        }
        if current.exists() {
            return Some(current);
        }
        if !current.pop() {
            return None;
        }
    }
}

#[cfg(windows)]
fn platform_disk_free_bytes(path: &Path) -> io::Result<u64> {
    use std::os::windows::ffi::OsStrExt;

    let existing = existing_ancestor(path)
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "disk path does not exist"))?;
    let mut wide: Vec<u16> = existing.as_os_str().encode_wide().collect();
    wide.push(0);
    let mut available = 0u64;
    let mut total = 0u64;
    let mut total_free = 0u64;
    let ok =
        unsafe { GetDiskFreeSpaceExW(wide.as_ptr(), &mut available, &mut total, &mut total_free) };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(available)
}

#[cfg(not(windows))]
fn platform_disk_free_bytes(_path: &Path) -> io::Result<u64> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "disk free space is only implemented on Windows",
    ))
}

#[cfg(windows)]
#[link(name = "kernel32")]
unsafe extern "system" {
    fn GetDiskFreeSpaceExW(
        directory: *const u16,
        free_bytes_available: *mut u64,
        total_bytes: *mut u64,
        total_free_bytes: *mut u64,
    ) -> i32;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn thresholds_use_the_documented_boundaries() {
        let start = MIN_FREE_BYTES_TO_START;
        let during = MIN_FREE_BYTES_WHILE_RECORDING;
        assert!(can_start_recording(start, start));
        assert!(!can_start_recording(start - 1, start));
        assert!(!should_stop_for_disk(during, during));
        assert!(should_stop_for_disk(during - 1, during));
        assert_eq!(estimated_export_bytes(1_000), 1_200);
        assert_eq!(estimated_export_bytes(0), 0);
        assert!(can_export(1_200, 1_000));
        assert!(!can_export(1_199, 1_000));
        assert_eq!(threshold_bytes(None, start), start);
        assert_eq!(threshold_bytes(Some(f64::NAN), start), start);
        assert_eq!(threshold_bytes(Some(4096.0), start), 4096);
        assert_eq!(format_gib(start), "2.0");
        assert_eq!(format_gib(during), "1.0");
        assert!(start_refused_message(start).contains("无法开始录制"));
        assert!(export_refused_message(1_200).contains("无法导出"));
    }

    #[test]
    #[cfg(windows)]
    fn windows_temp_dir_reports_free_bytes() {
        let free = disk_free_bytes(&std::env::temp_dir()).expect("temp free bytes");
        assert!(free > 0, "{free}");
    }
}
