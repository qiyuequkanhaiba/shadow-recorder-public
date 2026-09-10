import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { app } from 'electron';

import type {
  ReqCaseShadowRecorderConfig,
  ReqCaseShadowRecorderPersistedSettings,
} from './types';
import type { SemanticProfileImportRecord } from '../../../types/contracts';

const SETTINGS_FILENAME = 'reqcase-shadow-recorder.settings.json';

function getSettingsFilePath(): string {
  return path.join(app.getPath('userData'), SETTINGS_FILENAME);
}

function sanitizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const values = value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((item, index, items) => items.indexOf(item) === index);
  return values.length > 0 ? values : [];
}

function sanitizeNonNegativeInteger(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 0;
}

function sanitizeMaskRegions(value: unknown): ReqCaseShadowRecorderConfig['maskRegions'] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value
    .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
    .map((item) => ({
      x: sanitizeNonNegativeInteger(item.x),
      y: sanitizeNonNegativeInteger(item.y),
      width: sanitizeNonNegativeInteger(item.width),
      height: sanitizeNonNegativeInteger(item.height),
      label: typeof item.label === 'string' ? item.label.trim() : '',
    }))
    .filter((region) => region.width > 0 && region.height > 0);
}



function makeProfileRecordId(profile: Record<string, unknown>, sourceFileName: string, fallbackIndex = 0): string {
  const profileId = typeof profile.profileId === 'string' ? profile.profileId.trim() : '';
  if (profileId) return profileId;
  const name = typeof profile.name === 'string' ? profile.name.trim() : '';
  if (name) return `name:${name}`;
  const base = sourceFileName.replace(/\.json$/i, '').trim() || 'profile';
  return `${base}-${fallbackIndex + 1}`;
}

function sanitizeSemanticProfileImport(value: unknown, index = 0): SemanticProfileImportRecord | null | undefined {
  if (value === null) {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const input = value as Record<string, unknown>;
  if (!input.profile || typeof input.profile !== 'object' || Array.isArray(input.profile)) {
    return undefined;
  }
  const profile = input.profile as Record<string, unknown>;
  const sourceFileName =
    typeof input.sourceFileName === 'string' && input.sourceFileName.trim()
      ? input.sourceFileName.trim()
      : 'imported-profile.json';
  const importedAtMs =
    typeof input.importedAtMs === 'number' && Number.isFinite(input.importedAtMs)
      ? Math.trunc(input.importedAtMs)
      : Date.now();
  const idRaw = typeof input.id === 'string' ? input.id.trim() : '';
  const id = idRaw || makeProfileRecordId(profile, sourceFileName, index);
  const record: SemanticProfileImportRecord = {
    id,
    sourceFileName,
    importedAtMs,
    profile,
  };
  if (typeof input.sourcePath === 'string' && input.sourcePath.trim()) {
    record.sourcePath = input.sourcePath.trim();
  }
  if (typeof input.updatedAtMs === 'number' && Number.isFinite(input.updatedAtMs)) {
    record.updatedAtMs = Math.trunc(input.updatedAtMs);
  }
  return record;
}

function sanitizeSemanticProfilesList(value: unknown): SemanticProfileImportRecord[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const out: SemanticProfileImportRecord[] = [];
  const seen = new Set<string>();
  value.forEach((item, index) => {
    const rec = sanitizeSemanticProfileImport(item, index);
    if (!rec) return;
    if (seen.has(rec.id)) {
      const existing = out.findIndex((r) => r.id === rec.id);
      if (existing >= 0) out.splice(existing, 1);
    }
    seen.add(rec.id);
    out.push(rec);
  });
  return out;
}


function sanitizeRecorderConfig(input: ReqCaseShadowRecorderConfig): ReqCaseShadowRecorderConfig {
  const output: ReqCaseShadowRecorderConfig = { ...input };

  delete output.defectEvidenceEnabled;
  delete output.semanticRecordingEnabled;
  delete output.uiaObserverEnabled;
  delete output.operationBuilderEnabled;
  delete output.operationReviewV2Enabled;
  delete output.semanticPlaintextInputEnabled;
  delete output.defectPreWindowSeconds;
  delete output.defectPostWindowSeconds;

  if (typeof input.defectEvidenceEnabled === 'boolean') {
    output.defectEvidenceEnabled = input.defectEvidenceEnabled;
  }
  if (typeof input.semanticRecordingEnabled === 'boolean') {
    output.semanticRecordingEnabled = input.semanticRecordingEnabled;
  }
  if (typeof input.uiaObserverEnabled === 'boolean') {
    output.uiaObserverEnabled = input.uiaObserverEnabled;
  }
  if (typeof input.operationBuilderEnabled === 'boolean') {
    output.operationBuilderEnabled = input.operationBuilderEnabled;
  }
  if (typeof input.operationReviewV2Enabled === 'boolean') {
    output.operationReviewV2Enabled = input.operationReviewV2Enabled;
  }
  if (typeof input.semanticPlaintextInputEnabled === 'boolean') {
    output.semanticPlaintextInputEnabled = input.semanticPlaintextInputEnabled;
  }
  if (typeof input.defectPreWindowSeconds === 'number' && Number.isFinite(input.defectPreWindowSeconds)) {
    output.defectPreWindowSeconds = Math.max(5, Math.min(600, Math.trunc(input.defectPreWindowSeconds)));
  }
  if (typeof input.defectPostWindowSeconds === 'number' && Number.isFinite(input.defectPostWindowSeconds)) {
    output.defectPostWindowSeconds = Math.max(0, Math.min(300, Math.trunc(input.defectPostWindowSeconds)));
  }

  delete output.privacyEnabled;
  delete output.aiReplayProvider;
  delete output.aiReplayOpenAiBaseUrl;
  delete output.aiReplayOpenAiApiKey;
  delete output.aiReplayOpenAiModel;
  delete output.aiReplayOpenAiTimeoutMs;
  delete output.aiReplayEnabled;
  delete output.excludedWindowTitleKeywords;
  delete output.excludedProcessNames;
  delete output.maskRegions;

  if (
    input.aiReplayProvider === 'disabled'
    || input.aiReplayProvider === 'mock'
    || input.aiReplayProvider === 'openai_compatible'
  ) {
    output.aiReplayProvider = input.aiReplayProvider;
  }

  if (typeof input.aiReplayOpenAiBaseUrl === 'string') {
    output.aiReplayOpenAiBaseUrl = input.aiReplayOpenAiBaseUrl.trim();
  }

  if (typeof input.aiReplayOpenAiApiKey === 'string') {
    output.aiReplayOpenAiApiKey = input.aiReplayOpenAiApiKey.trim();
  }

  if (typeof input.aiReplayOpenAiModel === 'string') {
    output.aiReplayOpenAiModel = input.aiReplayOpenAiModel.trim();
  }

  if (typeof input.aiReplayOpenAiTimeoutMs === 'number' && Number.isFinite(input.aiReplayOpenAiTimeoutMs)) {
    output.aiReplayOpenAiTimeoutMs = Math.max(1_000, Math.min(120_000, Math.trunc(input.aiReplayOpenAiTimeoutMs)));
  }

  if (typeof input.aiReplayEnabled === 'boolean') {
    output.aiReplayEnabled = input.aiReplayEnabled;
  }

  if (typeof input.privacyEnabled === 'boolean') {
    output.privacyEnabled = input.privacyEnabled;
  }

  const excludedWindowTitleKeywords = sanitizeStringArray(input.excludedWindowTitleKeywords);
  if (excludedWindowTitleKeywords) {
    output.excludedWindowTitleKeywords = excludedWindowTitleKeywords;
  }

  const excludedProcessNames = sanitizeStringArray(input.excludedProcessNames);
  if (excludedProcessNames) {
    output.excludedProcessNames = excludedProcessNames;
  }

  const maskRegions = sanitizeMaskRegions(input.maskRegions);
  if (maskRegions) {
    output.maskRegions = maskRegions;
  }

  return output;
}

export function loadRecorderSettings(): ReqCaseShadowRecorderPersistedSettings {
  const settingsPath = getSettingsFilePath();
  try {
    const raw = readFileSync(settingsPath, 'utf-8');
    const parsed = JSON.parse(raw) as ReqCaseShadowRecorderPersistedSettings;
    return parsed ?? {};
  } catch {
    return {};
  }
}

export function sanitizeRecorderSettings(
  input: ReqCaseShadowRecorderPersistedSettings,
): ReqCaseShadowRecorderPersistedSettings {
  const output: ReqCaseShadowRecorderPersistedSettings = {};

  if (input.config && typeof input.config === 'object') {
    output.config = sanitizeRecorderConfig(input.config);
  }

  if (typeof input.autoApplyLastRecommendedProfile === 'boolean') {
    output.autoApplyLastRecommendedProfile = input.autoApplyLastRecommendedProfile;
  }

  if (
    input.lastRecommendedProfile === 'stability'
    || input.lastRecommendedProfile === 'latency'
    || input.lastRecommendedProfile === 'size'
  ) {
    output.lastRecommendedProfile = input.lastRecommendedProfile;
  }

  if (typeof input.lastRecommendationReason === 'string') {
    output.lastRecommendationReason = input.lastRecommendationReason;
  }

  if (typeof input.updatedAtMs === 'number') {
    output.updatedAtMs = input.updatedAtMs;
  }

  if ('semanticProfile' in input) {
    const semanticProfile = sanitizeSemanticProfileImport(input.semanticProfile);
    if (semanticProfile !== undefined) {
      output.semanticProfile = semanticProfile;
    }
  }

  if ('semanticProfiles' in input) {
    const semanticProfiles = sanitizeSemanticProfilesList(input.semanticProfiles);
    if (semanticProfiles !== undefined) {
      output.semanticProfiles = semanticProfiles;
    }
  }

  if ('activeSemanticProfileId' in input) {
    if (input.activeSemanticProfileId === null) {
      output.activeSemanticProfileId = null;
    } else if (typeof input.activeSemanticProfileId === 'string') {
      output.activeSemanticProfileId = input.activeSemanticProfileId.trim() || null;
    }
  }

  // Migrate legacy single semanticProfile → list
  if ((!output.semanticProfiles || output.semanticProfiles.length === 0) && output.semanticProfile?.profile) {
    const legacy = sanitizeSemanticProfileImport(output.semanticProfile, 0);
    if (legacy) {
      output.semanticProfiles = [legacy];
      if (!output.activeSemanticProfileId) {
        output.activeSemanticProfileId = legacy.id;
      }
    }
  }

  return output;
}

let pendingSettingsWrite: ReqCaseShadowRecorderPersistedSettings | null = null;
let flushPromise: Promise<void> | null = null;

async function flushSettingsWrites(): Promise<void> {
  while (pendingSettingsWrite) {
    const settings = pendingSettingsWrite;
    pendingSettingsWrite = null;

    const settingsPath = getSettingsFilePath();
    await mkdir(path.dirname(settingsPath), { recursive: true });

    const payload: ReqCaseShadowRecorderPersistedSettings = {
      ...settings,
      updatedAtMs: Date.now(),
    };

    await writeFile(settingsPath, JSON.stringify(payload, null, 2), 'utf-8');
  }
}

export function saveRecorderSettings(settings: ReqCaseShadowRecorderPersistedSettings): Promise<void> {
  pendingSettingsWrite = settings;
  if (!flushPromise) {
    flushPromise = flushSettingsWrites().finally(() => {
      flushPromise = null;
    });
  }
  return flushPromise;
}

export async function flushRecorderSettingsWrites(): Promise<void> {
  if (flushPromise) {
    await flushPromise;
  }
}

export function saveRecorderSettingsSync(settings: ReqCaseShadowRecorderPersistedSettings): void {
  const settingsPath = getSettingsFilePath();
  mkdirSync(path.dirname(settingsPath), { recursive: true });

  const payload: ReqCaseShadowRecorderPersistedSettings = {
    ...settings,
    updatedAtMs: Date.now(),
  };

  writeFileSync(settingsPath, JSON.stringify(payload, null, 2), 'utf-8');
}
