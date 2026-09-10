use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process;
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use log::info;
use windows_record::{AudioSource, Recorder, VideoEncoderType, VideoProfile, VideoSampleTransport};
use windows_sys::Win32::Graphics::Gdi::{DEVMODEW, ENUM_CURRENT_SETTINGS, EnumDisplaySettingsW};

type AppResult<T> = Result<T, Box<dyn std::error::Error>>;

#[derive(Debug, Clone, Copy)]
enum AudioMode {
    Off,
    Desktop,
    ActiveWindow,
}

#[derive(Debug, Clone)]
struct CliConfig {
    window_title: String,
    duration_seconds: u64,
    fps: u32,
    output_path: PathBuf,
    input_width: Option<u32>,
    input_height: Option<u32>,
    output_width: Option<u32>,
    output_height: Option<u32>,
    video_bitrate: u32,
    video_encoder: VideoEncoderType,
    video_profile: VideoProfile,
    video_sample_transport: VideoSampleTransport,
    enable_hardware_transforms: bool,
    disable_sink_throttling: bool,
    enable_low_latency: bool,
    enable_async_video_processor: bool,
    exact_match: bool,
    debug_mode: bool,
    wait_before_start_ms: u64,
    audio_mode: AudioMode,
    replay_buffer_seconds: Option<u32>,
    save_replay_path: Option<PathBuf>,
}

fn main() {
    if let Err(err) = run() {
        eprintln!("[windows-record-poc] {err}");
        process::exit(1);
    }
}

fn run() -> AppResult<()> {
    let config = parse_args(env::args().skip(1).collect())?;
    init_logging(config.debug_mode);

    if let Some(parent) = config.output_path.parent() {
        fs::create_dir_all(parent)?;
    }
    if let Some(replay_path) = config.save_replay_path.as_ref() {
        if let Some(parent) = replay_path.parent() {
            fs::create_dir_all(parent)?;
        }
    }

    info!("starting windows-record WR-0 compatibility PoC");
    info!("window title match: {}", config.window_title);
    info!("output: {}", config.output_path.display());
    let (input_width, input_height) = resolve_dimensions(
        config.input_width,
        config.input_height,
        detect_primary_display_dimensions().map(|(width, height)| (width, height)),
    );
    let (output_width, output_height) = resolve_dimensions(
        config.output_width,
        config.output_height,
        Some((input_width, input_height)),
    );
    info!("input dimensions: {}x{}", input_width, input_height);
    info!("output dimensions: {}x{}", output_width, output_height);

    let mut builder = Recorder::builder()
        .fps(config.fps, 1)
        .input_dimensions(input_width, input_height)
        .output_dimensions(output_width, output_height)
        .output_path(&config.output_path)
        .video_bitrate(config.video_bitrate)
        .video_encoder(config.video_encoder.clone())
        .video_profile(config.video_profile.clone())
        .video_sample_transport(config.video_sample_transport.clone())
        .enable_hardware_transforms(config.enable_hardware_transforms)
        .disable_sink_throttling(config.disable_sink_throttling)
        .enable_low_latency(config.enable_low_latency)
        .enable_async_video_processor(config.enable_async_video_processor)
        .debug_mode(config.debug_mode);

    match config.audio_mode {
        AudioMode::Off => {
            builder = builder.capture_audio(false).capture_microphone(false);
        }
        AudioMode::Desktop => {
            builder = builder
                .capture_audio(true)
                .capture_microphone(false)
                .audio_source(AudioSource::Desktop);
        }
        AudioMode::ActiveWindow => {
            builder = builder
                .capture_audio(true)
                .capture_microphone(false)
                .audio_source(AudioSource::ActiveWindow);
        }
    }

    if let Some(replay_buffer_seconds) = config.replay_buffer_seconds {
        builder = builder
            .enable_replay_buffer(true)
            .replay_buffer_seconds(replay_buffer_seconds);
    }

    let recorder = Recorder::new(builder.build())?
        .with_process_name(&config.window_title)
        .with_exact_match(config.exact_match);

    if config.wait_before_start_ms > 0 {
        thread::sleep(Duration::from_millis(config.wait_before_start_ms));
    }

    recorder.start_recording()?;
    info!("recording for {} seconds", config.duration_seconds);
    thread::sleep(Duration::from_secs(config.duration_seconds));

    if let Some(replay_path) = config.save_replay_path.as_ref() {
        recorder.save_replay(&replay_path.to_string_lossy())?;
        info!("saved replay buffer to {}", replay_path.display());
    }

    recorder.stop_recording()?;
    info!("recording stopped");

    let metadata = fs::metadata(&config.output_path)?;
    println!(
        "[windows-record-poc] output={} bytes={}",
        config.output_path.display(),
        metadata.len()
    );
    Ok(())
}

fn parse_args(args: Vec<String>) -> AppResult<CliConfig> {
    if args.is_empty() || args.iter().any(|arg| arg == "--help" || arg == "-h") {
        print_help();
        process::exit(0);
    }

    let mut window_title: Option<String> = None;
    let mut duration_seconds = 6u64;
    let mut fps = 30u32;
    let mut output_path: Option<PathBuf> = None;
    let mut input_width: Option<u32> = None;
    let mut input_height: Option<u32> = None;
    let mut output_width: Option<u32> = None;
    let mut output_height: Option<u32> = None;
    let mut video_bitrate = 5_000_000u32;
    let mut video_encoder = VideoEncoderType::H264;
    let mut video_profile = VideoProfile::Auto;
    let mut video_sample_transport = VideoSampleTransport::DxgiSurface;
    let mut enable_hardware_transforms = true;
    let mut disable_sink_throttling = true;
    let mut enable_low_latency = true;
    let mut enable_async_video_processor = true;
    let mut exact_match = false;
    let mut debug_mode = false;
    let mut wait_before_start_ms = 800u64;
    let mut audio_mode = AudioMode::Off;
    let mut replay_buffer_seconds: Option<u32> = None;
    let mut save_replay_path: Option<PathBuf> = None;

    let mut index = 0usize;
    while index < args.len() {
        match args[index].as_str() {
            "--window" => {
                index += 1;
                window_title = Some(require_value(&args, index, "--window")?.to_string());
            }
            "--duration" => {
                index += 1;
                duration_seconds = require_value(&args, index, "--duration")?.parse()?;
            }
            "--fps" => {
                index += 1;
                fps = require_value(&args, index, "--fps")?.parse()?;
            }
            "--output" => {
                index += 1;
                output_path = Some(PathBuf::from(require_value(&args, index, "--output")?));
            }
            "--input-width" => {
                index += 1;
                input_width = Some(require_value(&args, index, "--input-width")?.parse()?);
            }
            "--input-height" => {
                index += 1;
                input_height = Some(require_value(&args, index, "--input-height")?.parse()?);
            }
            "--output-width" => {
                index += 1;
                output_width = Some(require_value(&args, index, "--output-width")?.parse()?);
            }
            "--output-height" => {
                index += 1;
                output_height = Some(require_value(&args, index, "--output-height")?.parse()?);
            }
            "--bitrate" => {
                index += 1;
                video_bitrate = require_value(&args, index, "--bitrate")?.parse()?;
            }
            "--encoder" => {
                index += 1;
                video_encoder = match require_value(&args, index, "--encoder")? {
                    "h264" => VideoEncoderType::H264,
                    "hevc" | "h265" => VideoEncoderType::HEVC,
                    value => {
                        return Err(format!(
                            "unsupported --encoder value: {value}. expected h264|hevc"
                        )
                        .into());
                    }
                };
            }
            "--profile" => {
                index += 1;
                video_profile = match require_value(&args, index, "--profile")? {
                    "auto" => VideoProfile::Auto,
                    "h264-baseline" | "baseline" => VideoProfile::H264Baseline,
                    "h264-main" | "main" => VideoProfile::H264Main,
                    "h264-high" | "high" => VideoProfile::H264High,
                    "hevc-main" => VideoProfile::HevcMain,
                    value => {
                        return Err(format!(
                            "unsupported --profile value: {value}. expected auto|h264-baseline|h264-main|h264-high|hevc-main"
                        )
                        .into());
                    }
                };
            }
            "--sample-transport" => {
                index += 1;
                video_sample_transport = match require_value(&args, index, "--sample-transport")? {
                    "dxgi" => VideoSampleTransport::DxgiSurface,
                    "memory" => VideoSampleTransport::SystemMemory,
                    value => {
                        return Err(format!(
                            "unsupported --sample-transport value: {value}. expected dxgi|memory"
                        )
                        .into());
                    }
                };
            }
            "--audio" => {
                index += 1;
                audio_mode = match require_value(&args, index, "--audio")? {
                    "off" => AudioMode::Off,
                    "desktop" => AudioMode::Desktop,
                    "window" => AudioMode::ActiveWindow,
                    value => {
                        return Err(format!(
                            "unsupported --audio value: {value}. expected off|desktop|window"
                        )
                        .into());
                    }
                };
            }
            "--replay-buffer-seconds" => {
                index += 1;
                replay_buffer_seconds = Some(
                    require_value(&args, index, "--replay-buffer-seconds")?.parse()?,
                );
            }
            "--save-replay" => {
                index += 1;
                save_replay_path = Some(PathBuf::from(require_value(&args, index, "--save-replay")?));
            }
            "--wait-before-start-ms" => {
                index += 1;
                wait_before_start_ms =
                    require_value(&args, index, "--wait-before-start-ms")?.parse()?;
            }
            "--disable-hw-transforms" => enable_hardware_transforms = false,
            "--enable-sink-throttling" => disable_sink_throttling = false,
            "--disable-low-latency" => enable_low_latency = false,
            "--disable-async-converter" => enable_async_video_processor = false,
            "--exact" => exact_match = true,
            "--debug" => debug_mode = true,
            value => {
                return Err(format!("unknown argument: {value}").into());
            }
        }
        index += 1;
    }

    let window_title = window_title.ok_or_else(|| {
        "--window is required. Use scripts/list-visible-window-titles.ps1 to find a title.".to_string()
    })?;
    let output_path = output_path.unwrap_or_else(default_output_path);

    Ok(CliConfig {
        window_title,
        duration_seconds,
        fps,
        output_path,
        input_width,
        input_height,
        output_width,
        output_height,
        video_bitrate,
        video_encoder,
        video_profile,
        video_sample_transport,
        enable_hardware_transforms,
        disable_sink_throttling,
        enable_low_latency,
        enable_async_video_processor,
        exact_match,
        debug_mode,
        wait_before_start_ms,
        audio_mode,
        replay_buffer_seconds,
        save_replay_path,
    })
}

fn require_value<'a>(args: &'a [String], index: usize, flag: &str) -> AppResult<&'a str> {
    args.get(index)
        .map(|value| value.as_str())
        .ok_or_else(|| format!("missing value for {flag}").into())
}

fn default_output_path() -> PathBuf {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    Path::new("D:/python/shadowrecord/reports/windows-record-poc")
        .join(format!("windows-record-poc-{timestamp}.mp4"))
}

fn resolve_dimensions(
    width: Option<u32>,
    height: Option<u32>,
    fallback: Option<(u32, u32)>,
) -> (u32, u32) {
    match (width, height) {
        (Some(w), Some(h)) if w > 0 && h > 0 => (w, h),
        _ => fallback.unwrap_or((1920, 1080)),
    }
}

fn detect_primary_display_dimensions() -> Option<(u32, u32)> {
    let mut dev_mode = DEVMODEW::default();
    dev_mode.dmSize = std::mem::size_of::<DEVMODEW>() as u16;
    let ok = unsafe { EnumDisplaySettingsW(std::ptr::null(), ENUM_CURRENT_SETTINGS, &mut dev_mode) };
    if ok == 0 {
        return None;
    }
    let width = dev_mode.dmPelsWidth;
    let height = dev_mode.dmPelsHeight;
    if width == 0 || height == 0 {
        return None;
    }
    Some((width, height))
}

fn init_logging(debug_mode: bool) {
    let mut builder = env_logger::Builder::from_default_env();
    if debug_mode {
        builder.filter_level(log::LevelFilter::Debug);
    } else {
        builder.filter_level(log::LevelFilter::Warn);
    }
    let _ = builder.try_init();
}

fn print_help() {
    println!(
        "\
windows-record WR-0 compatibility PoC

Important:
- The crate API name is `with_process_name`, but it actually matches visible window title text.
- Use scripts/list-visible-window-titles.ps1 to find a usable window title first.

Usage:
  cargo run --manifest-path tools/windows-record-poc/Cargo.toml -- \\
    --window <visible-window-title-substring> \\
    [--duration <seconds>] \\
    [--fps <fps>] \\
    [--output <path>] \\
    [--input-width <px>] [--input-height <px>] \\
    [--output-width <px>] [--output-height <px>] \\
    [--bitrate <bps>] \\
    [--encoder h264|hevc] \\
    [--profile auto|h264-baseline|h264-main|h264-high|hevc-main] \\
    [--sample-transport dxgi|memory] \\
    [--disable-hw-transforms] [--enable-sink-throttling] \\
    [--disable-low-latency] [--disable-async-converter] \\
    [--audio off|desktop|window] \\
    [--exact] \\
    [--debug] \\
    [--wait-before-start-ms <ms>] \\
    [--replay-buffer-seconds <seconds>] \\
    [--save-replay <path>]
"
    );
}
