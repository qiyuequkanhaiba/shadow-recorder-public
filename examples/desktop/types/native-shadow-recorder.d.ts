import type {
  TestSessionOperationRecord,
  TestSessionOperationUpdateInput,
} from './operation-contracts';

export interface ShadowRecorderNativeOperationCompatibilityDiagnostic {
  code: string;
  severity: 'info' | 'warning' | 'error' | (string & {});
  lineNumber?: number;
  schemaVersion?: number;
  message: string;
}

export interface ShadowRecorderNativeOperationTailResult {
  items: TestSessionOperationRecord[];
  nextCursor?: string;
  reset: boolean;
  totalCount: number;
  diagnostics: ShadowRecorderNativeOperationCompatibilityDiagnostic[];
}

export interface ShadowRecorderNativeOperationBinding {
  getTestSessionOperations?(
    sessionId?: string,
    cursor?: string,
    limit?: number,
  ): ShadowRecorderNativeOperationTailResult;
  rebuildTestSessionOperations?(sessionId?: string): TestSessionOperationRecord[];
  updateTestSessionMeta?(input?: any): any;

  updateTestSessionOperation?(input?: TestSessionOperationUpdateInput): TestSessionOperationRecord;
  exportTestDefectPack?(input?: {
    sessionId?: string;
    targetDir?: string;
    markedAtMs?: number;
    preWindowSeconds?: number;
    postWindowSeconds?: number;
    note?: string;
    expected?: string;
    actual?: string;
  }): Promise<{
    packDir: string;
    reproStepsPath: string;
    summaryPath: string;
    stepsPath: string;
    manifestPath: string;
    stepCount: number;
    screenshotCount: number;
    videoSegmentCount: number;
    clipPath?: string;
    clipBuilt: boolean;
  }>;
  getTestSessionSteps?(sessionId?: string, limit?: number): unknown[];
  setSemanticAliasProfile?(profile?: unknown): unknown;
  getSemanticAliasProfile?(): unknown;
  loadSemanticProfile?(path: string): string;
  importSemanticProfile?(): string | null;
  setSemanticProfileJson?(content: string): string;
  getSemanticProfileJson?(): string | null;
  clearSemanticProfile?(): void;
}

export type ShadowRecorderNativeBinding = ShadowRecorderNativeOperationBinding & Record<string, unknown>;
