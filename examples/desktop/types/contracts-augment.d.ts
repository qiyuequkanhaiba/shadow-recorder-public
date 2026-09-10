import './contracts';

declare module './contracts' {
  interface RecorderConfigPayload {
    targetCaptureMode?:
      | 'foreground_window'
      | 'target_window'
      | 'process_bind'
      | 'desktop'
      | 'target_display'
      | 'all_displays';
  }
}
