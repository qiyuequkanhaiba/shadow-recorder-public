# -*- coding: utf-8 -*-
"""Multi semantic profile persistence + IPC activate/remove."""
from pathlib import Path
import re

root = Path(__file__).resolve().parents[1]
desktop = root / "examples" / "desktop"

# ---- contracts.ts ----
contracts = desktop / "types" / "contracts.ts"
c = contracts.read_text(encoding="utf-8")
old_rec = """/** Imported semantic profile persisted in app settings (survives restarts). */
export interface SemanticProfileImportRecord {
  sourceFileName: string;
  sourcePath?: string;
  importedAtMs: number;
  /** Normalized profile object (alias/scenario rules, target process, etc.). */
  profile: Record<string, unknown>;
}"""
new_rec = """/** One imported semantic profile entry (multi-app library). */
export interface SemanticProfileImportRecord {
  /** Stable id for tabs / activation (defaults to profile.profileId or generated). */
  id: string;
  sourceFileName: string;
  sourcePath?: string;
  importedAtMs: number;
  updatedAtMs?: number;
  /** Normalized profile object (alias/scenario rules, target process, etc.). */
  profile: Record<string, unknown>;
}"""
if "id: string;" not in c or "SemanticProfileImportRecord" in c and "id: string" not in c[c.find("SemanticProfileImportRecord"):c.find("SemanticProfileImportRecord")+400]:
    if old_rec in c:
        c = c.replace(old_rec, new_rec)
    else:
        # try loose replace of interface body
        c = re.sub(
            r"export interface SemanticProfileImportRecord \{[\s\S]*?\n\}",
            new_rec,
            c,
            count=1,
        )
    print("contracts record updated")

old_persisted = """  /** Last imported semantic profile; restored into native on app start. */
  semanticProfile?: SemanticProfileImportRecord | null;"""
new_persisted = """  /**
   * @deprecated Prefer semanticProfiles + activeSemanticProfileId.
   * Kept for migration of single-profile settings.
   */
  semanticProfile?: SemanticProfileImportRecord | null;
  /** Library of imported profiles (one tab per entry / software). */
  semanticProfiles?: SemanticProfileImportRecord[];
  /** Currently active profile id (loaded into native binding). */
  activeSemanticProfileId?: string | null;"""
if "semanticProfiles?" not in c:
    if old_persisted in c:
        c = c.replace(old_persisted, new_persisted)
    else:
        c = c.replace(
            "semanticProfile?: SemanticProfileImportRecord | null;",
            new_persisted,
        )
    print("contracts settings fields updated")
contracts.write_text(c, encoding="utf-8")

# ---- settings-store.ts ----
ss = desktop / "src-electron" / "modules" / "reqcase-shadow-recorder" / "settings-store.ts"
st = ss.read_text(encoding="utf-8")

helper = r'''
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
    // de-dupe by id, keep last
    if (seen.has(rec.id)) {
      const existing = out.findIndex((r) => r.id === rec.id);
      if (existing >= 0) out.splice(existing, 1);
    }
    seen.add(rec.id);
    out.push(rec);
  });
  return out;
}

'''

# Replace old sanitizeSemanticProfileImport function if present
if "sanitizeSemanticProfilesList" not in st:
    st = re.sub(
        r"function sanitizeSemanticProfileImport\(value: unknown\): SemanticProfileImportRecord \| null \| undefined \{[\s\S]*?\n\}\n",
        helper,
        st,
        count=1,
    )
    # If still missing (function body differed), insert before sanitizeRecorderConfig
    if "sanitizeSemanticProfilesList" not in st:
        st = st.replace(
            "function sanitizeRecorderConfig(input: ReqCaseShadowRecorderConfig): ReqCaseShadowRecorderConfig {",
            helper + "function sanitizeRecorderConfig(input: ReqCaseShadowRecorderConfig): ReqCaseShadowRecorderConfig {",
        )
    print("settings helper updated")

# Update sanitizeRecorderSettings block for multi profiles
old_block = """  if ('semanticProfile' in input) {
    const semanticProfile = sanitizeSemanticProfileImport(input.semanticProfile);
    if (semanticProfile !== undefined) {
      output.semanticProfile = semanticProfile;
    }
  }

  return output;
}"""
new_block = """  if ('semanticProfile' in input) {
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
}"""
if "semanticProfiles" not in st or "Migrate legacy" not in st:
    if old_block in st:
        st = st.replace(old_block, new_block)
    else:
        # CRLF
        if old_block.replace("\n", "\r\n") in st:
            st = st.replace(old_block.replace("\n", "\r\n"), new_block.replace("\n", "\r\n"))
        else:
            print("WARN: sanitize block not found, appending fields manually may be needed")
    print("settings sanitize multi updated")
ss.write_text(st, encoding="utf-8")

# ---- ipc-channels ----
ch = desktop / "src-electron" / "modules" / "reqcase-shadow-recorder" / "ipc-channels.ts"
chs = ch.read_text(encoding="utf-8")
if "setActiveSemanticProfile" not in chs:
    chs = chs.replace(
        "clearSemanticProfile: 'reqcase:shadow-recorder:clear-semantic-profile',",
        "clearSemanticProfile: 'reqcase:shadow-recorder:clear-semantic-profile',\n"
        "  setActiveSemanticProfile: 'reqcase:shadow-recorder:set-active-semantic-profile',\n"
        "  removeSemanticProfile: 'reqcase:shadow-recorder:remove-semantic-profile',",
    )
    ch.write_text(chs, encoding="utf-8")
    print("channels updated")

# ---- preload ----
pl = desktop / "src-electron" / "preload.ts"
ps = pl.read_text(encoding="utf-8")
if "setActiveSemanticProfile" not in ps:
    ps = ps.replace(
        "clearSemanticProfile?: () => Promise<void>;",
        "clearSemanticProfile?: () => Promise<void>;\n"
        "  setActiveSemanticProfile?: (input: string | { id: string }) => Promise<string | null>;\n"
        "  removeSemanticProfile?: (input: string | { id: string }) => Promise<void>;",
    )
    ps = ps.replace(
        "clearSemanticProfile: () => ipcRenderer.invoke('reqcase:shadow-recorder:clear-semantic-profile'),",
        "clearSemanticProfile: () => ipcRenderer.invoke('reqcase:shadow-recorder:clear-semantic-profile'),\n"
        "    setActiveSemanticProfile: (input) => ipcRenderer.invoke('reqcase:shadow-recorder:set-active-semantic-profile', input),\n"
        "    removeSemanticProfile: (input) => ipcRenderer.invoke('reqcase:shadow-recorder:remove-semantic-profile', input),",
    )
    pl.write_text(ps, encoding="utf-8")
    print("preload updated")

# ---- ipc.ts helpers + handlers ----
ipc_path = desktop / "src-electron" / "modules" / "reqcase-shadow-recorder" / "ipc.ts"
ipc = ipc_path.read_text(encoding="utf-8")
nl = "\r\n" if "\r\n" in ipc else "\n"

helpers = f"""
  const profileRecordId = (
    profile: Record<string, unknown>,
    sourceFileName: string,
    fallbackIndex = 0,
  ): string => {{
    const profileId = typeof profile.profileId === 'string' ? profile.profileId.trim() : '';
    if (profileId) return profileId;
    const name = typeof profile.name === 'string' ? profile.name.trim() : '';
    if (name) return `name:${{name}}`;
    const base = sourceFileName.replace(/\\.json$/i, '').trim() || 'profile';
    return `${{base}}-${{fallbackIndex + 1}}`;
  }};

  const listSemanticProfiles = (): Array<{{
    id: string;
    sourceFileName: string;
    sourcePath?: string;
    importedAtMs: number;
    updatedAtMs?: number;
    profile: Record<string, unknown>;
  }}> => {{
    const fromList = Array.isArray(runtimeSettings.semanticProfiles)
      ? runtimeSettings.semanticProfiles
      : [];
    if (fromList.length > 0) {{
      return fromList as any;
    }}
    const legacy = runtimeSettings.semanticProfile as any;
    if (legacy?.profile && typeof legacy.profile === 'object') {{
      const id =
        typeof legacy.id === 'string' && legacy.id.trim()
          ? legacy.id.trim()
          : profileRecordId(legacy.profile, legacy.sourceFileName || 'imported-profile.json', 0);
      return [
        {{
          id,
          sourceFileName: legacy.sourceFileName || 'imported-profile.json',
          sourcePath: legacy.sourcePath,
          importedAtMs: legacy.importedAtMs || Date.now(),
          updatedAtMs: legacy.updatedAtMs,
          profile: legacy.profile,
        }},
      ];
    }}
    return [];
  }};

  const upsertSemanticProfile = (entry: {{
    id?: string;
    sourceFileName: string;
    sourcePath?: string;
    profile: Record<string, unknown>;
  }>) => {{
    const list = listSemanticProfiles();
    const id =
      (entry.id && entry.id.trim()) ||
      profileRecordId(entry.profile, entry.sourceFileName, list.length);
    const now = Date.now();
    const existingIndex = list.findIndex((item) => item.id === id);
    const nextEntry = {{
      id,
      sourceFileName: entry.sourceFileName,
      sourcePath: entry.sourcePath,
      importedAtMs: existingIndex >= 0 ? list[existingIndex].importedAtMs : now,
      updatedAtMs: now,
      profile: entry.profile,
    }};
    const nextList =
      existingIndex >= 0
        ? list.map((item, index) => (index === existingIndex ? nextEntry : item))
        : [...list, nextEntry];
    runtimeSettings = {{
      ...runtimeSettings,
      semanticProfiles: nextList,
      activeSemanticProfileId: id,
      // keep legacy mirror for older readers
      semanticProfile: nextEntry,
    }};
    return nextEntry;
  }};

  const activateSemanticProfileById = (id: string): string | null => {{
    const list = listSemanticProfiles();
    const found = list.find((item) => item.id === id);
    if (!found?.profile) {{
      return null;
    }}
    const restored = service.restoreSemanticProfileObject(found.profile);
    runtimeSettings = {{
      ...runtimeSettings,
      semanticProfiles: list,
      activeSemanticProfileId: found.id,
      semanticProfile: found,
    }};
    return restored;
  }};
"""

if "listSemanticProfiles" not in ipc:
    # insert after restorePersistedSemanticProfile block
    marker = "  restorePersistedSemanticProfile();"
    if marker not in ipc:
        raise SystemExit("restore marker not found")
    # Replace restore function + call with multi-aware restore + helpers
    old_restore = re.search(
        r"  const restorePersistedSemanticProfile = \(\): void => \{[\s\S]*?  restorePersistedSemanticProfile\(\);",
        ipc,
    )
    if not old_restore:
        raise SystemExit("restore block regex failed")
    new_restore = f"""  const restorePersistedSemanticProfile = (): void => {{
    const list = (() => {{
      const fromList = Array.isArray(runtimeSettings.semanticProfiles)
        ? (runtimeSettings.semanticProfiles as any[])
        : [];
      if (fromList.length > 0) return fromList;
      const legacy = runtimeSettings.semanticProfile as any;
      if (legacy?.profile && typeof legacy.profile === 'object') {{
        return [legacy];
      }}
      return [];
    }})();
    if (list.length === 0) {{
      return;
    }}
    const activeId =
      typeof runtimeSettings.activeSemanticProfileId === 'string'
        ? runtimeSettings.activeSemanticProfileId
        : null;
    const selected =
      (activeId && list.find((item: any) => item?.id === activeId || item?.profile?.profileId === activeId)) ||
      list[0];
    if (!selected?.profile || typeof selected.profile !== 'object') {{
      return;
    }}
    try {{
      service.restoreSemanticProfileObject(selected.profile as Record<string, unknown>);
      // ensure multi fields present after migration
      if (!Array.isArray(runtimeSettings.semanticProfiles) || runtimeSettings.semanticProfiles.length === 0) {{
        const id =
          typeof selected.id === 'string' && selected.id
            ? selected.id
            : String(selected.profile?.profileId || 'imported');
        runtimeSettings = {{
          ...runtimeSettings,
          semanticProfiles: [{{ ...selected, id }}],
          activeSemanticProfileId: id,
        }};
        void saveRecorderSettings(runtimeSettings);
      }}
    }} catch (error) {{
      console.error('Failed to restore persisted semantic profile', error);
    }}
  }};
  restorePersistedSemanticProfile();
{helpers}"""
    ipc = ipc[: old_restore.start()] + new_restore + ipc[old_restore.end() :]
    print("restore+helpers inserted")

# Replace import / load / set / clear handlers to use multi list
# Import handler body
import_re = re.compile(
    r"ipcMain\.handle\('reqcase:shadow-recorder:import-semantic-profile', async \(\) => \{[\s\S]*?\n  \}\);"
)
import_new = """ipcMain.handle('reqcase:shadow-recorder:import-semantic-profile', async () => {
    const result = await dialog.showOpenDialog({
      title: '导入语义画像',
      properties: ['openFile'],
      filters: [
        { name: 'Semantic Profile JSON', extensions: ['json'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });
    if (result.canceled || !result.filePaths[0]) {
      return null;
    }
    const profilePath = result.filePaths[0];
    const imported = service.importSemanticProfileFromPath(profilePath);
    const entry = upsertSemanticProfile({
      sourceFileName: path.basename(profilePath),
      sourcePath: profilePath,
      profile: imported.profile,
    });
    await saveRecorderSettings(runtimeSettings);
    return JSON.stringify({
      ...imported.profile,
      __recordId: entry.id,
      __profiles: listSemanticProfiles().map((p) => ({
        id: p.id,
        name: (p.profile as any)?.name,
        profileId: (p.profile as any)?.profileId,
        targetProcessName: (p.profile as any)?.targetProcessName,
        aliasCount: Array.isArray((p.profile as any)?.aliasRules) ? (p.profile as any).aliasRules.length : 0,
        sourceFileName: p.sourceFileName,
      })),
      __activeId: entry.id,
    });
  });"""

if "upsertSemanticProfile" in ipc:
    m = import_re.search(ipc)
    if m:
        ipc = ipc[: m.start()] + import_new + ipc[m.end() :]
        print("import handler multi")

# load-semantic-profile similarly
load_re = re.compile(
    r"ipcMain\.handle\('reqcase:shadow-recorder:load-semantic-profile', async \(_event, input\) => \{[\s\S]*?\n  \}\);"
)
load_new = """ipcMain.handle('reqcase:shadow-recorder:load-semantic-profile', async (_event, input) => {
    const profilePath = typeof input === 'string' ? input : input?.path;
    if (!profilePath || typeof profilePath !== 'string') {
      throw new Error('semantic profile path is required');
    }
    const imported = service.importSemanticProfileFromPath(profilePath);
    const entry = upsertSemanticProfile({
      sourceFileName: path.basename(profilePath),
      sourcePath: profilePath,
      profile: imported.profile,
    });
    await saveRecorderSettings(runtimeSettings);
    return imported.profileJson;
  });"""
m = load_re.search(ipc)
if m and "upsertSemanticProfile" in ipc:
    ipc = ipc[: m.start()] + load_new + ipc[m.end() :]
    print("load handler multi")

set_re = re.compile(
    r"ipcMain\.handle\('reqcase:shadow-recorder:set-semantic-profile-json', async \(_event, input\) => \{[\s\S]*?\n  \}\);"
)
set_new = """ipcMain.handle('reqcase:shadow-recorder:set-semantic-profile-json', async (_event, input) => {
    const content =
      typeof input === 'string'
        ? input
        : input && typeof input === 'object' && typeof (input as any).json === 'string'
          ? (input as any).json
          : input && typeof input === 'object' && (input as any).profile
            ? JSON.stringify((input as any).profile)
            : null;
    if (!content || typeof content !== 'string') {
      throw new Error('semantic profile JSON content is required');
    }
    const saved = service.setSemanticProfileJson(content);
    const preferredId =
      input && typeof input === 'object' && typeof (input as any).id === 'string'
        ? (input as any).id.trim()
        : typeof runtimeSettings.activeSemanticProfileId === 'string'
          ? runtimeSettings.activeSemanticProfileId
          : undefined;
    const list = listSemanticProfiles();
    const existing = preferredId ? list.find((p) => p.id === preferredId) : undefined;
    const entry = upsertSemanticProfile({
      id: preferredId || undefined,
      sourceFileName: existing?.sourceFileName || 'edited-profile.json',
      sourcePath: existing?.sourcePath,
      profile: saved.profile,
    });
    await saveRecorderSettings(runtimeSettings);
    return saved.profileJson;
  });"""
m = set_re.search(ipc)
if m:
    ipc = ipc[: m.start()] + set_new + ipc[m.end() :]
    print("set handler multi")

clear_re = re.compile(
    r"ipcMain\.handle\('reqcase:shadow-recorder:clear-semantic-profile', async \(\) => \{[\s\S]*?\n  \}\);"
)
# keep clear as clear-all for now; remove is separate
clear_new = """ipcMain.handle('reqcase:shadow-recorder:clear-semantic-profile', async () => {
    service.clearSemanticProfile();
    runtimeSettings = {
      ...runtimeSettings,
      semanticProfile: null,
      semanticProfiles: [],
      activeSemanticProfileId: null,
    };
    await saveRecorderSettings(runtimeSettings);
  });

  ipcMain.handle('reqcase:shadow-recorder:set-active-semantic-profile', async (_event, input) => {
    const id = typeof input === 'string' ? input : input?.id;
    if (!id || typeof id !== 'string') {
      throw new Error('semantic profile id is required');
    }
    const restored = activateSemanticProfileById(id);
    if (!restored) {
      throw new Error(`semantic profile not found: ${id}`);
    }
    await saveRecorderSettings(runtimeSettings);
    return restored;
  });

  ipcMain.handle('reqcase:shadow-recorder:remove-semantic-profile', async (_event, input) => {
    const id = typeof input === 'string' ? input : input?.id;
    if (!id || typeof id !== 'string') {
      throw new Error('semantic profile id is required');
    }
    const list = listSemanticProfiles().filter((item) => item.id !== id);
    const activeId = runtimeSettings.activeSemanticProfileId;
    runtimeSettings = {
      ...runtimeSettings,
      semanticProfiles: list,
      activeSemanticProfileId:
        activeId === id ? (list[0]?.id ?? null) : (activeId as string | null | undefined) ?? null,
      semanticProfile: list[0] ?? null,
    };
    if (activeId === id) {
      if (list[0]?.profile) {
        service.restoreSemanticProfileObject(list[0].profile);
      } else {
        service.clearSemanticProfile();
      }
    }
    await saveRecorderSettings(runtimeSettings);
  });"""
m = clear_re.search(ipc)
if m and "remove-semantic-profile" not in ipc:
    ipc = ipc[: m.start()] + clear_new + ipc[m.end() :]
    print("clear+activate+remove handlers")

ipc_path.write_text(ipc, encoding="utf-8")
print("ipc written")
print("DONE")
