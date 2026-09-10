use std::path::Path;

use windows::Win32::Foundation::{BOOL, LPARAM, RECT};
use windows::Win32::Graphics::Gdi::GetMonitorInfoW;
use windows::Win32::Graphics::Gdi::{EnumDisplayMonitors, HDC, HMONITOR, MONITORINFO};

use crate::session::models::{
    DEFAULT_SEGMENT_DURATION_SECONDS, TEST_SESSION_VIDEO_STREAM_KIND, TestSessionRecord,
    TestSessionVideoStreamRecord, TestSessionVideoStreamStatus,
};

pub(crate) fn resolve_recording_profile_capture_params(profile: &str) -> (u32, u32) {
    match profile {
        "efficiency" => (143, 7),
        "smooth" => (50, 20),
        _ => (71, 14),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TestSessionDisplayTarget {
    pub display_id: String,
    pub label: String,
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
    pub width: u32,
    pub height: u32,
    pub is_primary: bool,
}

impl TestSessionDisplayTarget {
    fn from_monitor_rect(ordinal: usize, hmonitor: HMONITOR, rect: RECT, is_primary: bool) -> Self {
        let width = (rect.right - rect.left).max(0) as u32;
        let height = (rect.bottom - rect.top).max(0) as u32;
        let display_id = format!("monitor-{:#x}", hmonitor.0 as usize);
        let label = if is_primary {
            "Primary Display".to_string()
        } else {
            format!("Display {}", ordinal + 1)
        };

        Self {
            display_id,
            label,
            left: rect.left,
            top: rect.top,
            right: rect.right,
            bottom: rect.bottom,
            width,
            height,
            is_primary,
        }
    }
}

pub fn enumerate_display_targets() -> Vec<TestSessionDisplayTarget> {
    let mut displays = Vec::new();
    let displays_ptr = &mut displays as *mut Vec<TestSessionDisplayTarget>;

    unsafe extern "system" fn callback(
        hmonitor: HMONITOR,
        _hdc: HDC,
        _rect: *mut RECT,
        lparam: LPARAM,
    ) -> BOOL {
        let displays = unsafe { &mut *(lparam.0 as *mut Vec<TestSessionDisplayTarget>) };
        let mut monitor_info = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };

        if unsafe { GetMonitorInfoW(hmonitor, &mut monitor_info) }.as_bool() {
            let rect = monitor_info.rcMonitor;
            let is_primary = (monitor_info.dwFlags & 1) == 1;
            let ordinal = displays.len();
            displays.push(TestSessionDisplayTarget::from_monitor_rect(
                ordinal, hmonitor, rect, is_primary,
            ));
        }

        true.into()
    }

    let _ = unsafe {
        EnumDisplayMonitors(
            HDC(std::ptr::null_mut()),
            None,
            Some(callback),
            LPARAM(displays_ptr as isize),
        )
    };

    displays.sort_by_key(|display: &TestSessionDisplayTarget| {
        (!display.is_primary, display.top, display.left)
    });
    displays
}

pub fn build_video_stream_plan(
    session: &TestSessionRecord,
    displays: &[TestSessionDisplayTarget],
) -> Vec<TestSessionVideoStreamRecord> {
    match session.target_capture_mode.as_str() {
        // process_bind: UIA/steps bind to process, but video should still cover full desktop
        // (previously fell into window stream with null geometry → gdigrab 0,0 1920x1080 only).
        "all_displays" | "process_bind" => {
            let sources = resolve_selected_displays(session, displays);
            let sources = if sources.is_empty() {
                vec![fallback_display_target()]
            } else {
                sources
            };
            sources
                .iter()
                .enumerate()
                .map(|(index, display)| {
                    create_display_stream_record(
                        session,
                        &format!("vs-display-{}", index + 1),
                        display,
                    )
                })
                .collect()
        }
        "target_display" | "desktop" => {
            let display =
                resolve_target_display(session, displays).unwrap_or_else(fallback_display_target);
            vec![create_display_stream_record(
                session,
                "vs-display-primary",
                &display,
            )]
        }
        _ => vec![create_window_stream_record(session, "vs-window-primary")],
    }
}

fn resolve_target_display(
    session: &TestSessionRecord,
    displays: &[TestSessionDisplayTarget],
) -> Option<TestSessionDisplayTarget> {
    if let Some(display_id) = session.target_display_id.as_deref()
        && let Some(display) = displays
            .iter()
            .find(|candidate| candidate.display_id == display_id)
    {
        return Some(display.clone());
    }

    if let Some(display_ids) = session.target_display_ids.as_ref()
        && let Some(display) = displays
            .iter()
            .find(|candidate| display_ids.contains(&candidate.display_id))
    {
        return Some(display.clone());
    }

    displays
        .iter()
        .find(|display| display.is_primary)
        .cloned()
        .or_else(|| displays.first().cloned())
}

fn resolve_selected_displays(
    session: &TestSessionRecord,
    displays: &[TestSessionDisplayTarget],
) -> Vec<TestSessionDisplayTarget> {
    let Some(display_ids) = session.target_display_ids.as_ref() else {
        return displays.to_vec();
    };

    let selected: Vec<TestSessionDisplayTarget> = displays
        .iter()
        .filter(|display| display_ids.contains(&display.display_id))
        .cloned()
        .collect();

    if selected.is_empty() {
        displays.to_vec()
    } else {
        selected
    }
}

fn create_display_stream_record(
    session: &TestSessionRecord,
    stream_id: &str,
    display: &TestSessionDisplayTarget,
) -> TestSessionVideoStreamRecord {
    let (sample_interval_ms, target_fps) =
        resolve_recording_profile_capture_params(&session.recording_profile);
    let stream_dir = session.session_dir.as_deref().map(|session_dir| {
        Path::new(session_dir)
            .join("video")
            .join("streams")
            .join(stream_id)
            .to_string_lossy()
            .into_owned()
    });
    let manifest_path = stream_dir.as_deref().map(|stream_dir| {
        Path::new(stream_dir)
            .join("stream.json")
            .to_string_lossy()
            .into_owned()
    });
    let playlist_path = stream_dir.as_deref().map(|stream_dir| {
        Path::new(stream_dir)
            .join("playback.mp4")
            .to_string_lossy()
            .into_owned()
    });

    TestSessionVideoStreamRecord {
        schema_version: 1,
        kind: TEST_SESSION_VIDEO_STREAM_KIND.to_string(),
        stream_id: stream_id.to_string(),
        session_id: session.session_id.clone(),
        label: display.label.clone(),
        status: TestSessionVideoStreamStatus::Planned,
        target_capture_mode: session.target_capture_mode.clone(),
        display_id: Some(display.display_id.clone()),
        display_label: Some(display.label.clone()),
        width: Some(display.width),
        height: Some(display.height),
        monitor_left: Some(display.left),
        monitor_top: Some(display.top),
        monitor_right: Some(display.right),
        monitor_bottom: Some(display.bottom),
        started_at_ms: session.started_at_ms,
        updated_at_ms: session.updated_at_ms,
        segment_duration_seconds: session
            .segment_duration_seconds
            .max(DEFAULT_SEGMENT_DURATION_SECONDS),
        segment_count: 0,
        playable_segment_count: 0,
        pending_segment_count: 0,
        total_segment_bytes: 0,
        retained_segment_bytes: 0,
        last_segment_bytes: None,
        last_segment_duration_ms: None,
        last_segment_frame_count: None,
        last_capture_latency_ms: None,
        last_encode_latency_ms: None,
        sample_interval_ms,
        target_fps,
        encoder_available: false,
        warning_count: 0,
        last_warning: None,
        stream_dir,
        manifest_path,
        playlist_path,
    }
}

fn create_window_stream_record(
    session: &TestSessionRecord,
    stream_id: &str,
) -> TestSessionVideoStreamRecord {
    let (sample_interval_ms, target_fps) =
        resolve_recording_profile_capture_params(&session.recording_profile);
    let stream_dir = session.session_dir.as_deref().map(|session_dir| {
        Path::new(session_dir)
            .join("video")
            .join("streams")
            .join(stream_id)
            .to_string_lossy()
            .into_owned()
    });
    let manifest_path = stream_dir.as_deref().map(|stream_dir| {
        Path::new(stream_dir)
            .join("stream.json")
            .to_string_lossy()
            .into_owned()
    });
    let playlist_path = stream_dir.as_deref().map(|stream_dir| {
        Path::new(stream_dir)
            .join("playback.mp4")
            .to_string_lossy()
            .into_owned()
    });

    TestSessionVideoStreamRecord {
        schema_version: 1,
        kind: TEST_SESSION_VIDEO_STREAM_KIND.to_string(),
        stream_id: stream_id.to_string(),
        session_id: session.session_id.clone(),
        label: "Window Capture".to_string(),
        status: TestSessionVideoStreamStatus::Planned,
        target_capture_mode: session.target_capture_mode.clone(),
        display_id: session.target_display_id.clone(),
        display_label: None,
        width: None,
        height: None,
        monitor_left: None,
        monitor_top: None,
        monitor_right: None,
        monitor_bottom: None,
        started_at_ms: session.started_at_ms,
        updated_at_ms: session.updated_at_ms,
        segment_duration_seconds: session
            .segment_duration_seconds
            .max(DEFAULT_SEGMENT_DURATION_SECONDS),
        segment_count: 0,
        playable_segment_count: 0,
        pending_segment_count: 0,
        total_segment_bytes: 0,
        retained_segment_bytes: 0,
        last_segment_bytes: None,
        last_segment_duration_ms: None,
        last_segment_frame_count: None,
        last_capture_latency_ms: None,
        last_encode_latency_ms: None,
        sample_interval_ms,
        target_fps,
        encoder_available: false,
        warning_count: 0,
        last_warning: None,
        stream_dir,
        manifest_path,
        playlist_path,
    }
}

fn fallback_display_target() -> TestSessionDisplayTarget {
    TestSessionDisplayTarget {
        display_id: "display-auto-primary".to_string(),
        label: "Primary Display".to_string(),
        left: 0,
        top: 0,
        right: 1920,
        bottom: 1080,
        width: 1920,
        height: 1080,
        is_primary: true,
    }
}

#[cfg(test)]
mod tests {
    use super::{TestSessionDisplayTarget, build_video_stream_plan};
    use crate::session::models::{TestSessionRecord, TestSessionStatus};

    fn fake_session(
        capture_mode: &str,
        target_display_id: Option<&str>,
        target_display_ids: Option<&[&str]>,
    ) -> TestSessionRecord {
        TestSessionRecord {
            schema_version: 1,
            kind: "reqcase.test-session".to_string(),
            session_id: "ts-1".to_string(),
            name: Some("demo".to_string()),
            status: TestSessionStatus::Active,
            started_at_ms: 10,
            updated_at_ms: 10,
            ended_at_ms: None,
            storage_root_dir: Some("D:/sessions".to_string()),
            session_dir: Some("D:/sessions/ts-1".to_string()),
            manifest_path: Some("D:/sessions/ts-1/session.json".to_string()),
            buffer_window_seconds: 180,
            segment_duration_seconds: 3,
            recording_profile: "balanced".to_string(),
            encoder_preference: "auto".to_string(),
            show_mouse_in_video: false,
            notes: None,
            target_process_name: None,
            target_pid: None,
            target_hwnd: None,
            target_display_id: target_display_id.map(str::to_string),
            target_display_ids: target_display_ids.map(|display_ids| {
                display_ids
                    .iter()
                    .map(|display_id| (*display_id).to_string())
                    .collect()
            }),
            target_capture_mode: capture_mode.to_string(),
        }
    }

    fn fake_displays() -> Vec<TestSessionDisplayTarget> {
        vec![
            TestSessionDisplayTarget {
                display_id: "display-secondary".to_string(),
                label: "Display 2".to_string(),
                left: -1920,
                top: 0,
                right: 0,
                bottom: 1080,
                width: 1920,
                height: 1080,
                is_primary: false,
            },
            TestSessionDisplayTarget {
                display_id: "display-primary".to_string(),
                label: "Primary Display".to_string(),
                left: 0,
                top: 0,
                right: 1920,
                bottom: 1080,
                width: 1920,
                height: 1080,
                is_primary: true,
            },
        ]
    }

    #[test]
    fn target_display_plan_prefers_requested_display() {
        let session = fake_session("target_display", Some("display-secondary"), None);
        let streams = build_video_stream_plan(&session, &fake_displays());
        assert_eq!(streams.len(), 1);
        assert_eq!(streams[0].display_id.as_deref(), Some("display-secondary"));
        assert_eq!(streams[0].label, "Display 2");
    }

    #[test]
    fn all_displays_plan_emits_stream_per_display() {
        let session = fake_session("all_displays", None, None);
        let streams = build_video_stream_plan(&session, &fake_displays());
        assert_eq!(streams.len(), 2);
        assert_eq!(streams[0].display_id.as_deref(), Some("display-secondary"));
        assert_eq!(streams[1].display_id.as_deref(), Some("display-primary"));
    }

    #[test]
    fn all_displays_plan_honors_selected_display_subset() {
        let session = fake_session("all_displays", None, Some(&["display-primary"]));
        let streams = build_video_stream_plan(&session, &fake_displays());
        assert_eq!(streams.len(), 1);
        assert_eq!(streams[0].display_id.as_deref(), Some("display-primary"));
        assert_eq!(streams[0].label, "Primary Display");
    }

    #[test]
    fn window_modes_emit_single_window_stream() {
        let session = fake_session("target_window", Some("display-primary"), None);
        let streams = build_video_stream_plan(&session, &fake_displays());
        assert_eq!(streams.len(), 1);
        assert_eq!(streams[0].label, "Window Capture");
        assert_eq!(streams[0].display_id.as_deref(), Some("display-primary"));
    }

    #[test]
    fn recording_profiles_change_stream_sampling_plan() {
        let mut efficiency = fake_session("target_display", Some("display-primary"), None);
        efficiency.recording_profile = "efficiency".to_string();
        let efficiency_stream = build_video_stream_plan(&efficiency, &fake_displays())
            .into_iter()
            .next()
            .expect("efficiency stream");

        let mut smooth = fake_session("target_display", Some("display-primary"), None);
        smooth.recording_profile = "smooth".to_string();
        let smooth_stream = build_video_stream_plan(&smooth, &fake_displays())
            .into_iter()
            .next()
            .expect("smooth stream");

        assert_eq!(efficiency_stream.target_fps, 7);
        assert_eq!(efficiency_stream.sample_interval_ms, 143);
        assert_eq!(smooth_stream.target_fps, 20);
        assert_eq!(smooth_stream.sample_interval_ms, 50);
    }
}
