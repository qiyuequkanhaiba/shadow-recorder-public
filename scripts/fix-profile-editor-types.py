# -*- coding: utf-8 -*-
from pathlib import Path
import re

desktop = Path(__file__).resolve().parents[1] / "examples" / "desktop"

nb = desktop / "src-electron" / "native-binding.ts"
s = nb.read_text(encoding="utf-8")
s = s.replace("const binding = getNativeBinding();", "const binding = getBinding() as any;")
nb.write_text(s, encoding="utf-8")
print("native-binding fixed")

ipc = desktop / "src-electron" / "modules" / "reqcase-shadow-recorder" / "ipc.ts"
t = ipc.read_text(encoding="utf-8")
nl = "\r\n" if "\r\n" in t else "\n"

new = nl.join(
    [
        "  ipcMain.handle('reqcase:shadow-recorder:set-semantic-profile-json', async (_event, input) => {",
        "    const content =",
        "      typeof input === 'string'",
        "        ? input",
        "        : input && typeof input === 'object' && typeof (input as any).json === 'string'",
        "          ? (input as any).json",
        "          : input && typeof input === 'object' && (input as any).profile",
        "            ? JSON.stringify((input as any).profile)",
        "            : null;",
        "    if (!content || typeof content !== 'string') {",
        "      throw new Error('semantic profile JSON content is required');",
        "    }",
        "    const saved = service.setSemanticProfileJson(content);",
        "    const prev = runtimeSettings.semanticProfile as",
        "      | { sourceFileName?: string; sourcePath?: string; importedAtMs?: number }",
        "      | null",
        "      | undefined;",
        "    runtimeSettings = {",
        "      ...runtimeSettings,",
        "      semanticProfile: {",
        "        sourceFileName:",
        "          prev && typeof prev.sourceFileName === 'string' && prev.sourceFileName.trim()",
        "            ? prev.sourceFileName",
        "            : 'edited-profile.json',",
        "        sourcePath: prev && typeof prev.sourcePath === 'string' ? prev.sourcePath : undefined,",
        "        importedAtMs: Date.now(),",
        "        profile: saved.profile,",
        "      },",
        "    };",
        "    await saveRecorderSettings(runtimeSettings);",
        "    return saved.profileJson;",
        "  });",
    ]
)

pattern = re.compile(
    r"  ipcMain\.handle\('reqcase:shadow-recorder:set-semantic-profile-json', async \(_event, input\) => \{[\s\S]*?\n  \}\);"
)
m = pattern.search(t)
if not m:
    raise SystemExit("set-semantic-profile-json handler not found")
t = t[: m.start()] + new + t[m.end() :]
ipc.write_text(t, encoding="utf-8")
print("ipc set handler rewritten")
