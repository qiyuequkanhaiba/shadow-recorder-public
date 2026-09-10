use std::collections::HashMap;
use std::path::Path;
use std::process::Command;
use std::sync::Mutex;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

use once_cell::sync::Lazy;

#[cfg(windows)]
const CREATE_NO_WINDOW_FLAG: u32 = 0x0800_0000;

static FFMPEG_ENCODER_CACHE: Lazy<Mutex<HashMap<String, Vec<VideoEncoderProfile>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum VideoEncoderProfile {
    SoftwareX264,
    HardwareNvenc,
    HardwareQsv,
    HardwareAmf,
    HardwareAv1Nvenc,
    HardwareHevcNvenc,
}

impl VideoEncoderProfile {
    pub(crate) fn encoder_name(self) -> &'static str {
        match self {
            Self::SoftwareX264 => "ffmpeg:libx264",
            Self::HardwareNvenc => "ffmpeg:h264_nvenc",
            Self::HardwareQsv => "ffmpeg:h264_qsv",
            Self::HardwareAmf => "ffmpeg:h264_amf",
            Self::HardwareAv1Nvenc => "ffmpeg:av1_nvenc",
            Self::HardwareHevcNvenc => "ffmpeg:hevc_nvenc",
        }
    }

    fn codec_name(self) -> &'static str {
        match self {
            Self::SoftwareX264 => "libx264",
            Self::HardwareNvenc => "h264_nvenc",
            Self::HardwareQsv => "h264_qsv",
            Self::HardwareAmf => "h264_amf",
            Self::HardwareAv1Nvenc => "av1_nvenc",
            Self::HardwareHevcNvenc => "hevc_nvenc",
        }
    }
}

pub(crate) fn resolve_encoder_candidates(
    ffmpeg: &Path,
    encoder_preference: &str,
) -> Vec<VideoEncoderProfile> {
    let cache_key = ffmpeg.to_string_lossy().to_string();
    if let Ok(cache) = FFMPEG_ENCODER_CACHE.lock()
        && let Some(cached) = cache.get(&cache_key)
    {
        return order_encoder_candidates(cached.clone(), encoder_preference);
    }

    let hardware = probe_available_hardware_encoders(ffmpeg);
    if let Ok(mut cache) = FFMPEG_ENCODER_CACHE.lock() {
        cache.insert(cache_key, hardware.clone());
    }

    order_encoder_candidates(hardware, encoder_preference)
}

fn probe_available_hardware_encoders(ffmpeg: &Path) -> Vec<VideoEncoderProfile> {
    let output = build_hidden_command(ffmpeg)
        .args(["-hide_banner", "-encoders"])
        .output();
    let Ok(output) = output else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    parse_available_hardware_encoders(&format!("{stdout}\n{stderr}"))
}

fn parse_available_hardware_encoders(output: &str) -> Vec<VideoEncoderProfile> {
    let combined = output.to_ascii_lowercase();
    let mut available = Vec::new();
    if combined.contains(" h264_nvenc") {
        available.push(VideoEncoderProfile::HardwareNvenc);
    }
    if combined.contains(" h264_qsv") {
        available.push(VideoEncoderProfile::HardwareQsv);
    }
    if combined.contains(" h264_amf") {
        available.push(VideoEncoderProfile::HardwareAmf);
    }
    if combined.contains(" av1_nvenc") {
        available.push(VideoEncoderProfile::HardwareAv1Nvenc);
    }
    if combined.contains(" hevc_nvenc") {
        available.push(VideoEncoderProfile::HardwareHevcNvenc);
    }
    available
}

fn order_encoder_candidates(
    hardware: Vec<VideoEncoderProfile>,
    encoder_preference: &str,
) -> Vec<VideoEncoderProfile> {
    let mut candidates = match encoder_preference {
        "hardware:av1" => {
            preferred_with_optional_codec(&hardware, VideoEncoderProfile::HardwareAv1Nvenc)
        }
        "hardware:hevc" => {
            preferred_with_optional_codec(&hardware, VideoEncoderProfile::HardwareHevcNvenc)
        }
        "hardware" => default_hardware_candidates(&hardware),
        "software" => vec![VideoEncoderProfile::SoftwareX264],
        _ => default_hardware_candidates(&hardware),
    };

    if candidates.is_empty() {
        candidates.push(VideoEncoderProfile::SoftwareX264);
    }
    candidates
}

fn default_hardware_candidates(hardware: &[VideoEncoderProfile]) -> Vec<VideoEncoderProfile> {
    hardware
        .iter()
        .copied()
        .filter(|profile| {
            !matches!(
                profile,
                VideoEncoderProfile::HardwareAv1Nvenc | VideoEncoderProfile::HardwareHevcNvenc
            )
        })
        .chain(std::iter::once(VideoEncoderProfile::SoftwareX264))
        .collect()
}

fn preferred_with_optional_codec(
    hardware: &[VideoEncoderProfile],
    optional_profile: VideoEncoderProfile,
) -> Vec<VideoEncoderProfile> {
    hardware
        .iter()
        .copied()
        .filter(|profile| *profile == optional_profile)
        .chain(default_hardware_candidates(hardware))
        .collect()
}

pub(crate) fn append_encoder_args(
    args: &mut Vec<String>,
    encoder_profile: VideoEncoderProfile,
    target_bitrate: &str,
) {
    match encoder_profile {
        VideoEncoderProfile::SoftwareX264 => {
            args.extend(
                [
                    "-c:v",
                    encoder_profile.codec_name(),
                    "-preset",
                    "veryfast",
                    "-tune",
                    "zerolatency",
                ]
                .map(String::from),
            );
            append_optional_bitrate(args, target_bitrate);
            args.extend(["-pix_fmt", "yuv420p"].map(String::from));
        }
        VideoEncoderProfile::HardwareNvenc
        | VideoEncoderProfile::HardwareAv1Nvenc
        | VideoEncoderProfile::HardwareHevcNvenc => {
            args.extend(
                [
                    "-c:v",
                    encoder_profile.codec_name(),
                    "-preset",
                    "p4",
                    "-tune",
                    "ll",
                    "-rc",
                    "vbr",
                    "-cq",
                    "28",
                ]
                .map(String::from),
            );
            append_optional_bitrate(args, target_bitrate);
            args.extend(["-pix_fmt", "yuv420p"].map(String::from));
        }
        VideoEncoderProfile::HardwareQsv => {
            args.extend(
                [
                    "-c:v",
                    encoder_profile.codec_name(),
                    "-preset",
                    "faster",
                    "-look_ahead",
                    "0",
                    "-global_quality",
                    "26",
                ]
                .map(String::from),
            );
            append_optional_bitrate(args, target_bitrate);
            args.extend(["-pix_fmt", "nv12"].map(String::from));
        }
        VideoEncoderProfile::HardwareAmf => {
            args.extend(
                [
                    "-c:v",
                    encoder_profile.codec_name(),
                    "-quality",
                    "speed",
                    "-usage",
                    "ultralowlatency",
                ]
                .map(String::from),
            );
            append_optional_bitrate(args, target_bitrate);
            args.extend(["-pix_fmt", "nv12"].map(String::from));
        }
    }
}

pub(crate) fn append_segmented_encoder_args(
    args: &mut Vec<String>,
    encoder_profile: VideoEncoderProfile,
    recording_profile: &str,
    gop_string: &str,
    force_key_frames: &str,
) {
    append_encoder_args(
        args,
        encoder_profile,
        match encoder_profile {
            VideoEncoderProfile::HardwareNvenc
            | VideoEncoderProfile::HardwareAv1Nvenc
            | VideoEncoderProfile::HardwareHevcNvenc => "0",
            _ => "",
        },
    );

    if encoder_profile == VideoEncoderProfile::SoftwareX264
        && let Some(preset_value) = find_arg_value_mut(args, "-preset")
    {
        *preset_value = resolve_x264_preset(recording_profile).to_string();
    }

    match encoder_profile {
        VideoEncoderProfile::SoftwareX264 => args.extend(
            [
                "-g",
                gop_string,
                "-keyint_min",
                gop_string,
                "-sc_threshold",
                "0",
                "-force_key_frames",
                force_key_frames,
            ]
            .map(String::from),
        ),
        VideoEncoderProfile::HardwareNvenc
        | VideoEncoderProfile::HardwareAv1Nvenc
        | VideoEncoderProfile::HardwareHevcNvenc => args.extend(
            [
                "-g",
                gop_string,
                "-keyint_min",
                gop_string,
                "-forced-idr",
                "1",
                "-force_key_frames",
                force_key_frames,
            ]
            .map(String::from),
        ),
        VideoEncoderProfile::HardwareQsv | VideoEncoderProfile::HardwareAmf => args.extend(
            [
                "-g",
                gop_string,
                "-keyint_min",
                gop_string,
                "-force_key_frames",
                force_key_frames,
            ]
            .map(String::from),
        ),
    }
}

fn append_optional_bitrate(args: &mut Vec<String>, target_bitrate: &str) {
    if !target_bitrate.is_empty() {
        args.extend(["-b:v", target_bitrate].map(String::from));
    }
}

fn find_arg_value_mut<'a>(args: &'a mut [String], key: &str) -> Option<&'a mut String> {
    args.windows(2)
        .position(|pair| pair.first().is_some_and(|value| value == key))
        .and_then(|index| args.get_mut(index + 1))
}

fn resolve_x264_preset(recording_profile: &str) -> &'static str {
    match recording_profile {
        "efficiency" => "ultrafast",
        "smooth" => "fast",
        _ => "veryfast",
    }
}

fn build_hidden_command(program: &Path) -> Command {
    #[cfg(windows)]
    {
        let mut command = Command::new(program);
        command.creation_flags(CREATE_NO_WINDOW_FLAG);
        command
    }

    #[cfg(not(windows))]
    {
        Command::new(program)
    }
}

#[cfg(test)]
mod tests {
    use super::{
        VideoEncoderProfile, append_encoder_args, append_segmented_encoder_args,
        order_encoder_candidates, parse_available_hardware_encoders, resolve_encoder_candidates,
    };
    use std::path::Path;

    #[test]
    fn parses_hardware_encoders_in_preferred_probe_order() {
        let output = " V....D h264_qsv Intel Quick Sync Video\n V....D h264_amf AMD AMF\n V....D h264_nvenc NVIDIA NVENC";

        assert_eq!(
            parse_available_hardware_encoders(output),
            vec![
                VideoEncoderProfile::HardwareNvenc,
                VideoEncoderProfile::HardwareQsv,
                VideoEncoderProfile::HardwareAmf,
            ]
        );
    }

    #[test]
    fn parses_optional_nvenc_codecs_without_enabling_them_by_default() {
        let output = " V....D av1_nvenc NVIDIA NVENC AV1\n V....D hevc_nvenc NVIDIA NVENC HEVC\n V....D h264_nvenc NVIDIA NVENC H.264";

        let hardware = parse_available_hardware_encoders(output);
        assert_eq!(
            hardware,
            vec![
                VideoEncoderProfile::HardwareNvenc,
                VideoEncoderProfile::HardwareAv1Nvenc,
                VideoEncoderProfile::HardwareHevcNvenc,
            ]
        );
        assert_eq!(
            order_encoder_candidates(hardware.clone(), "hardware"),
            vec![
                VideoEncoderProfile::HardwareNvenc,
                VideoEncoderProfile::SoftwareX264,
            ]
        );
        assert_eq!(
            order_encoder_candidates(hardware.clone(), "hardware:av1"),
            vec![
                VideoEncoderProfile::HardwareAv1Nvenc,
                VideoEncoderProfile::HardwareNvenc,
                VideoEncoderProfile::SoftwareX264,
            ]
        );
        assert_eq!(
            order_encoder_candidates(hardware, "hardware:hevc"),
            vec![
                VideoEncoderProfile::HardwareHevcNvenc,
                VideoEncoderProfile::HardwareNvenc,
                VideoEncoderProfile::SoftwareX264,
            ]
        );
    }

    #[test]
    fn hardware_preference_appends_software_fallback() {
        assert_eq!(
            order_encoder_candidates(
                vec![
                    VideoEncoderProfile::HardwareQsv,
                    VideoEncoderProfile::HardwareAmf
                ],
                "hardware",
            ),
            vec![
                VideoEncoderProfile::HardwareQsv,
                VideoEncoderProfile::HardwareAmf,
                VideoEncoderProfile::SoftwareX264,
            ]
        );
    }

    #[test]
    fn software_preference_skips_probe_results() {
        assert_eq!(
            order_encoder_candidates(vec![VideoEncoderProfile::HardwareNvenc], "software"),
            vec![VideoEncoderProfile::SoftwareX264]
        );
    }

    #[test]
    fn missing_ffmpeg_falls_back_to_software_encoder() {
        let candidates = resolve_encoder_candidates(
            Path::new("definitely-missing-shadowrecord-ffmpeg.exe"),
            "hardware",
        );

        assert_eq!(candidates, vec![VideoEncoderProfile::SoftwareX264]);
    }

    #[test]
    fn appends_segmented_encoder_args_without_runtime_command_dependency() {
        let mut args = Vec::new();

        append_segmented_encoder_args(
            &mut args,
            VideoEncoderProfile::HardwareNvenc,
            "balanced",
            "300",
            "expr:gte(t,n_forced*5)",
        );

        assert_eq!(args[0], "-c:v");
        assert_eq!(args[1], "h264_nvenc");
        assert!(args.windows(2).any(|pair| pair == ["-forced-idr", "1"]));
        assert!(
            args.windows(2)
                .any(|pair| pair == ["-force_key_frames", "expr:gte(t,n_forced*5)"])
        );
    }

    #[test]
    fn appends_encoder_args_with_target_bitrate_api() {
        let mut args = Vec::new();

        append_encoder_args(&mut args, VideoEncoderProfile::HardwareAmf, "4500k");

        assert_eq!(args[0], "-c:v");
        assert_eq!(args[1], "h264_amf");
        assert!(args.windows(2).any(|pair| pair == ["-b:v", "4500k"]));
        assert!(args.windows(2).any(|pair| pair == ["-pix_fmt", "nv12"]));
    }
}
