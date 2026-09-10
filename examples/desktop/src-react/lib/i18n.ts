export type Language = 'zh-CN' | 'en-US';

let currentLanguage: Language = 'zh-CN';

export function setLanguage(lang: Language): void {
  currentLanguage = lang;
}

export function getLanguage(): Language {
  return currentLanguage;
}

type TranslationKey =
  | 'config.recordingWindowSeconds'
  | 'config.segmentDurationSeconds'
  | 'config.showMouseInVideo'
  | 'config.maxBuffer'
  | 'config.debounce'
  | 'config.shortcutStart'
  | 'config.shortcutStop'
  | 'config.captureBackend'
  | 'config.transportMode'
  | 'config.captureReuse'
  | 'config.webpQuality'
  | 'config.targetImage'
  | 'config.backend.auto'
  | 'config.backend.dxgi'
  | 'config.backend.wgc'
  | 'config.transport.poll'
  | 'config.transport.push'
  | 'config.reuse.enabled'
  | 'config.reuse.disabled'
  | 'preset.recommendation'
  | 'preset.autoApply'
  | 'preset.stability'
  | 'preset.latency'
  | 'preset.size'
  | 'preset.apply'
  | 'preset.applyRecommended'
  | 'action.applyConfig'
  | 'action.startRecording'
  | 'action.stopRecording'
  | 'action.pauseRecording'
  | 'action.resumeRecording'
  | 'action.clearRecording'
  | 'action.minimizeTray'
  | 'timeline.noSteps';

const translations: Record<Language, Record<TranslationKey, string>> = {
  'zh-CN': {
    'config.recordingWindowSeconds': '最大录制时长 (秒)',
    'config.segmentDurationSeconds': '视频分段时长 (秒)',
    'config.showMouseInVideo': '在视频中显示鼠标',
    'config.maxBuffer': '最大缓冲 (MB)',
    'config.debounce': '防抖 (ms)',
    'config.shortcutStart': '全局快捷键: 开始录制',
    'config.shortcutStop': '全局快捷键: 停止录制',
    'config.captureBackend': '捕获后端',
    'config.transportMode': '传输模式',
    'config.captureReuse': '捕获上下文复用',
    'config.webpQuality': 'WebP 质量',
    'config.targetImage': '目标图片大小 (KB)',
    'config.backend.auto': '自动',
    'config.backend.dxgi': 'DXGI',
    'config.backend.wgc': 'WGC',
    'config.transport.poll': '轮询',
    'config.transport.push': '推送',
    'config.reuse.enabled': '启用 (推荐)',
    'config.reuse.disabled': '禁用 (安全回退)',
    'preset.recommendation': '推荐配置',
    'preset.autoApply': '启动时自动应用上次推荐配置',
    'preset.stability': '稳定性优先',
    'preset.latency': '低延迟优先',
    'preset.size': '小体积优先',
    'preset.apply': '应用',
    'preset.applyRecommended': '应用推荐配置',
    'action.applyConfig': '应用配置',
    'action.startRecording': '开始录制',
    'action.stopRecording': '停止录制',
    'action.pauseRecording': '暂停录制',
    'action.resumeRecording': '恢复录制',
    'action.clearRecording': '清除记录',
    'action.minimizeTray': '最小化到托盘',
    'timeline.noSteps': '暂无步骤',
  },
  'en-US': {
    'config.recordingWindowSeconds': 'Max Recording Window (s)',
    'config.segmentDurationSeconds': 'Video Segment Duration (s)',
    'config.showMouseInVideo': 'Show mouse in video',
    'config.maxBuffer': 'Max Buffer (MB)',
    'config.debounce': 'Debounce (ms)',
    'config.shortcutStart': 'Global Shortcut: Start',
    'config.shortcutStop': 'Global Shortcut: Stop',
    'config.captureBackend': 'Capture Backend',
    'config.transportMode': 'Transport Mode',
    'config.captureReuse': 'Capture Context Reuse',
    'config.webpQuality': 'WebP Quality',
    'config.targetImage': 'Target Image (KB)',
    'config.backend.auto': 'auto',
    'config.backend.dxgi': 'dxgi',
    'config.backend.wgc': 'wgc',
    'config.transport.poll': 'poll',
    'config.transport.push': 'push',
    'config.reuse.enabled': 'enabled (recommended)',
    'config.reuse.disabled': 'disabled (fallback-safe)',
    'preset.recommendation': 'Recommendation',
    'preset.autoApply': 'Auto-apply last recommended profile at startup',
    'preset.stability': 'Stability',
    'preset.latency': 'Latency',
    'preset.size': 'Size',
    'preset.apply': 'Apply',
    'preset.applyRecommended': 'Apply Recommended',
    'action.applyConfig': 'Apply config',
    'action.startRecording': 'Start recording',
    'action.stopRecording': 'Stop recording',
    'action.pauseRecording': 'Pause recording',
    'action.resumeRecording': 'Resume recording',
    'action.clearRecording': 'Clear recording',
    'action.minimizeTray': 'Minimize to tray',
    'timeline.noSteps': 'No steps yet',
  },
};

export function t(key: TranslationKey): string {
  return translations[currentLanguage][key] || key;
}
