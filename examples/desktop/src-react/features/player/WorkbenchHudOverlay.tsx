import type {
  RecorderMetrics,
  RecorderResourceUsage,
  TestSessionVideoStream,
} from '../../../types/contracts';
import type { CoordinateMappingResult } from '../../components/StudioDrawer';
import type { VideoEncoderSummary } from '../../lib/video-encoder-summary';
import { resolveBackendLabel, resolveHardwareEncoderBrand } from './coordinate-mapping';
import type { PlaybackStreamOption } from './usePlaybackStreams';
import styles from './Workbench.module.css';

export type WorkbenchHudOverlayProps = {
  selectedStream: TestSessionVideoStream | null;
  availablePlaybackStreams: PlaybackStreamOption[];
  activeStreamId: string | null;
  onChangeStream: (streamId: string) => void;
  encoderSummary: VideoEncoderSummary;
  activeEncoderName?: string | null;
  telemetryCollapsed: boolean;
  onToggleTelemetry: (collapsed: boolean) => void;
  metrics: RecorderMetrics | null;
  resourceUsage: RecorderResourceUsage | null;
  showMarkerOverlay: boolean;
  coordinateMappingResult: CoordinateMappingResult | null;
};

export function WorkbenchHudOverlay(props: WorkbenchHudOverlayProps) {
  const displayEncoderLabel =
    resolveHardwareEncoderBrand(props.activeEncoderName) ?? props.encoderSummary.encoderLabel;
  const encoderChips = [
    { title: '编码格式', value: props.encoderSummary.codecLabel },
    { title: '编码器', value: displayEncoderLabel },
    { title: '编码路径', value: props.encoderSummary.pathLabel },
  ].filter((chip) => chip.value && chip.value !== '--');
  const capturedSteps = props.metrics?.capturedStepsTotal ?? 0;
  const droppedSteps = props.metrics?.droppedStepsTotal ?? 0;
  const stepDropDisplay = capturedSteps > 0 ? `${droppedSteps} / ${capturedSteps}` : '--';
  const memoryDisplay =
    typeof props.resourceUsage?.totalWorkingSetMb === 'number'
      ? `${Math.round(props.resourceUsage.totalWorkingSetMb)} MB`
      : '--';
  const backendLabel = resolveBackendLabel(props.metrics);
  const hasTelemetry = Boolean(props.metrics || props.resourceUsage);

  return (
    <>
      <div className={styles.hudTopLeft} aria-label="流与编码信息">
        <div className={styles.streamRow}>
          <span className={styles.streamDisplay}>
            {props.selectedStream?.displayLabel ?? props.selectedStream?.label ?? '当前流'}
          </span>
          <span className={styles.streamResolution}>
            {props.selectedStream?.width && props.selectedStream?.height
              ? `${props.selectedStream.width}×${props.selectedStream.height}`
              : '--'}
          </span>
          {props.availablePlaybackStreams.length > 1 ? (
            <select
              className={styles.streamSelect}
              value={props.activeStreamId ?? ''}
              aria-label="切换显示流"
              onChange={(e) => props.onChangeStream(e.target.value)}
            >
              {props.availablePlaybackStreams.map((s) => (
                <option key={s.streamId} value={s.streamId}>
                  {s.displayLabel}
                </option>
              ))}
            </select>
          ) : null}
        </div>
        {encoderChips.length > 0 ? (
          <div className={styles.encoderRow}>
            {encoderChips.map((chip) => (
              <span key={chip.title} className={styles.metaChip} title={chip.title}>
                {chip.value}
              </span>
            ))}
          </div>
        ) : null}
      </div>

      {hasTelemetry ? (
        <div className={styles.hudTopRight} aria-label="实时核心指标">
          {props.telemetryCollapsed ? (
            <button
              type="button"
              className={styles.telemetryPillToggle}
              onClick={() => props.onToggleTelemetry(false)}
              title="展开实时遥测指标"
              aria-label="展开实时遥测指标"
            >
              <span className={styles.telemetryPillDot} />
              <span className={styles.telemetryPillText}>
                ⚡ 遥测{' '}
                {typeof props.metrics?.lastCaptureLatencyMs === 'number'
                  ? `${props.metrics.lastCaptureLatencyMs.toFixed(1)}ms`
                  : backendLabel}
              </span>
              <span className={styles.telemetryPillArrow}>▾</span>
            </button>
          ) : (
            <>
              <div className={styles.metricsGrid}>
                <div className={styles.metricBox}>
                  <span className={styles.metricKicker}>捕获时延</span>
                  <span className={`${styles.metricNum} ${styles.metricAccent}`}>
                    {typeof props.metrics?.lastCaptureLatencyMs === 'number'
                      ? `${props.metrics.lastCaptureLatencyMs.toFixed(1)} ms`
                      : '--'}
                  </span>
                </div>
                <div className={styles.metricBox}>
                  <span className={styles.metricKicker}>编码时延</span>
                  <span className={styles.metricNum}>
                    {typeof props.metrics?.lastEncodeLatencyMs === 'number'
                      ? `${props.metrics.lastEncodeLatencyMs.toFixed(1)} ms`
                      : '--'}
                  </span>
                </div>
                <div className={styles.metricBox}>
                  <span className={styles.metricKicker}>步骤丢弃</span>
                  <span className={styles.metricNum}>{stepDropDisplay}</span>
                </div>
                <div className={styles.metricBox}>
                  <span className={styles.metricKicker}>内存</span>
                  <span className={styles.metricNum}>{memoryDisplay}</span>
                </div>
              </div>
              <button
                type="button"
                className={styles.backendBadge}
                onClick={() => props.onToggleTelemetry(true)}
                title="收起遥测指标 (点击折叠)"
                aria-label="收起遥测指标"
              >
                {backendLabel} ▴
              </button>
            </>
          )}
        </div>
      ) : null}

      {props.showMarkerOverlay
        && props.coordinateMappingResult?.success
        && props.coordinateMappingResult.overlay ? (
          <div className={styles.overlayLayer} aria-hidden="true">
            {props.coordinateMappingResult.overlay.type === 'rect' ? (
              <div
                className={styles.overlayBoundingBox}
                style={{
                  left: `${props.coordinateMappingResult.overlay.x}px`,
                  top: `${props.coordinateMappingResult.overlay.y}px`,
                  width: `${props.coordinateMappingResult.overlay.width}px`,
                  height: `${props.coordinateMappingResult.overlay.height}px`,
                }}
              >
                {props.coordinateMappingResult.overlay.label ? (
                  <span className={styles.overlayBoxLabel}>
                    {props.coordinateMappingResult.overlay.label}
                  </span>
                ) : null}
              </div>
            ) : props.coordinateMappingResult.overlay.type === 'point' ? (
              <div
                className={styles.overlayClickPoint}
                style={{
                  left: `${props.coordinateMappingResult.overlay.x}px`,
                  top: `${props.coordinateMappingResult.overlay.y}px`,
                }}
              >
                <span className={styles.clickPulseRing} />
                <span className={styles.clickDot} />
                {props.coordinateMappingResult.overlay.label ? (
                  <span className={styles.overlayPointLabel}>
                    {props.coordinateMappingResult.overlay.label}
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
    </>
  );
}
