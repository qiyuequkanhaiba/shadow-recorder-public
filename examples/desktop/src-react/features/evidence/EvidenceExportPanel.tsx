import { useEffect, useMemo, useState } from 'react';

import type {
  TestSessionEvidenceExportResult,
  TestSessionState,
  TestSessionTimelineEvent,
  TestSessionVideoSegment,
} from '../../../types/contracts';

export type EvidenceExportMode = 'directory' | 'zip';

type EvidenceExportPanelProps = {
  session: TestSessionState | null;
  events: TestSessionTimelineEvent[];
  videoSegments: TestSessionVideoSegment[];
  outputMode: EvidenceExportMode | null;
  outputPath: string;
  privacyRulesActive: boolean;
  busy: boolean;
  result: TestSessionEvidenceExportResult | null;
  suggestedZipFileName?: string;
  onConfirmExport: (privacyAcknowledgedAt: string, zipFileName?: string) => void;
  onCancel: () => void;
};

function formatYesNo(value: boolean): string {
  return value ? 'yes' : 'no';
}

function countStepEvents(events: TestSessionTimelineEvent[]): number {
  return events.filter((event) => event.eventType === 'step_captured').length;
}

function countPlayableVideoSegments(videoSegments: TestSessionVideoSegment[]): number {
  return videoSegments.filter((segment) => segment.isPlayable || !!segment.relativePath || !!segment.filePath).length;
}

function containsScreenshots(events: TestSessionTimelineEvent[]): boolean {
  return events.some((event) => event.eventType === 'step_captured'
    && (!!event.fullImagePath || !!event.thumbImagePath || (event.imageBytes ?? 0) > 0));
}

function containsAppLogs(events: TestSessionTimelineEvent[]): boolean {
  return events.some((event) => event.logCategory === 'app');
}

function normalizeZipFileNameInput(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

export function EvidenceExportPanel(props: EvidenceExportPanelProps) {
  const suggestedZipFileName = useMemo(() => props.suggestedZipFileName ?? '', [props.suggestedZipFileName]);
  const [zipFileName, setZipFileName] = useState(suggestedZipFileName);

  useEffect(() => {
    if (props.outputMode === 'zip') {
      setZipFileName(suggestedZipFileName);
    }
  }, [props.outputMode, suggestedZipFileName]);

  if (!props.session || !props.outputMode) {
    return props.result?.artifactPath ? (
      <div className="recorder-log-export-tip">
        已导出到: {props.result.artifactPath}
      </div>
    ) : null;
  }

  const hasScreenshots = containsScreenshots(props.events);
  const hasAppLogs = containsAppLogs(props.events);
  const videoSegmentCount = countPlayableVideoSegments(props.videoSegments);
  const needsAcknowledgement = hasScreenshots || videoSegmentCount > 0;

  return (
    <section className="recorder-log-export-tip" aria-label="证据导出隐私确认">
      <strong>导出前确认</strong>
      <dl>
        <div>
          <dt>Session ID</dt>
          <dd>{props.session.sessionId}</dd>
        </div>
        <div>
          <dt>Step count</dt>
          <dd>{countStepEvents(props.events)}</dd>
        </div>
        <div>
          <dt>Video segment count</dt>
          <dd>{videoSegmentCount}</dd>
        </div>
        <div>
          <dt>Contains screenshots</dt>
          <dd>{formatYesNo(hasScreenshots)}</dd>
        </div>
        <div>
          <dt>Contains app logs</dt>
          <dd>{formatYesNo(hasAppLogs)}</dd>
        </div>
        <div>
          <dt>Privacy rules active</dt>
          <dd>{formatYesNo(props.privacyRulesActive)}</dd>
        </div>
        <div>
          <dt>Output path</dt>
          <dd>{props.outputPath}</dd>
        </div>
      </dl>
      {needsAcknowledgement ? (
        <p>该证据包可能包含截图或视频。请确认已检查隐私规则和导出范围。</p>
      ) : null}
      {props.outputMode === 'zip' ? (
        <label className="recorder-log-export-field">
          <span>ZIP 文件名</span>
          <input
            type="text"
            value={zipFileName}
            placeholder={suggestedZipFileName || '留空则自动生成'}
            disabled={props.busy}
            onChange={(event) => { setZipFileName(event.target.value); }}
          />
          <small>不需要填写路径；未填写扩展名时会自动补全 .zip。</small>
        </label>
      ) : null}
      <div className="recorder-log-actions">
        <button type="button" className="btn btn-ghost btn-sm" disabled={props.busy} onClick={props.onCancel}>
          取消
        </button>
        <button type="button"
          
          className={props.busy ? 'is-loading' : undefined}
          disabled={props.busy}
          onClick={() => {
            props.onConfirmExport(
              new Date().toISOString(),
              props.outputMode === 'zip' ? normalizeZipFileNameInput(zipFileName) : undefined,
            );
          }}
        >
          确认并导出{props.outputMode === 'zip' ? ' ZIP' : '目录'}
        </button>
      </div>
    </section>
  );
}
