export type EvidenceManifestFileEntry = {
  relativePath: string;
  sizeBytes?: number;
  role?: string;
};

export type EvidenceManifestChecksumEntry = {
  relativePath: string;
  sizeBytes: number;
  sha256: string;
};

export type EvidenceManifestOperationMetadata = {
  schemaVersion: number;
  builderVersion: string;
  kind: string;
  jsonRelativePath: string;
  csvRelativePath: string;
};

export type EvidenceManifestV2FileEntry = {
  relative_path: string;
  bytes: number;
  sha256: string;
};

export type EvidenceManifestV2Input = {
  sessionId: string | number;
  createdAtMs: number;
  appVersion: string;
  nativeVersion: string;
  os: string;
  captureConfig: Record<string, unknown>;
  operationsSchemaVersion: number;
  operationsBuilderVersion: string;
  operationsKind: string;
  operationsJsonRelativePath: string;
  operationsCsvRelativePath: string;
  checksums: EvidenceManifestChecksumEntry[];
};

export type EvidenceManifestInput = {
  app: Record<string, unknown>;
  session: Record<string, unknown>;
  files: EvidenceManifestFileEntry[];
  checksums: EvidenceManifestChecksumEntry[];
  operations?: EvidenceManifestOperationMetadata;
  createdAt?: string;
};

export type EvidenceManifest = {
  version: 1;
  createdAt: string;
  app: Record<string, unknown>;
  session: Record<string, unknown>;
  files: EvidenceManifestFileEntry[];
  checksums: EvidenceManifestChecksumEntry[];
  operations?: EvidenceManifestOperationMetadata;
};

export type EvidenceManifestV2 = {
  version: 2;
  session_id: string | number;
  created_at_ms: number;
  app_version: string;
  native_version: string;
  os: string;
  capture_config: Record<string, unknown>;
  operations_schema_version: number;
  operations_builder_version: string;
  operations_kind: string;
  operations_json_path: string;
  operations_csv_path: string;
  files: EvidenceManifestV2FileEntry[];
};

export function buildEvidenceManifest(input: EvidenceManifestInput): EvidenceManifest {
  return {
    version: 1,
    createdAt: input.createdAt ?? new Date().toISOString(),
    app: input.app,
    session: input.session,
    files: input.files,
    checksums: input.checksums,
    operations: input.operations,
  };
}

export function buildEvidenceManifestV2(input: EvidenceManifestV2Input): EvidenceManifestV2 {
  return {
    version: 2,
    session_id: input.sessionId,
    created_at_ms: input.createdAtMs,
    app_version: input.appVersion,
    native_version: input.nativeVersion,
    os: input.os,
    capture_config: input.captureConfig,
    operations_schema_version: input.operationsSchemaVersion,
    operations_builder_version: input.operationsBuilderVersion,
    operations_kind: input.operationsKind,
    operations_json_path: input.operationsJsonRelativePath,
    operations_csv_path: input.operationsCsvRelativePath,
    files: input.checksums.map((entry) => ({
      relative_path: entry.relativePath,
      bytes: entry.sizeBytes,
      sha256: entry.sha256,
    })),
  };
}
