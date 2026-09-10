import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../examples/desktop');
const read = (rel) => fs.readFileSync(path.join(desktop, rel), 'utf8');

const checks = [
  ['service importSemantic', read('src-electron/modules/reqcase-shadow-recorder/service.ts').includes('importSemanticProfileFromPath')],
  ['service fs import', read('src-electron/modules/reqcase-shadow-recorder/service.ts').includes("from 'node:fs'")],
  ['ipc import handler', read('src-electron/modules/reqcase-shadow-recorder/ipc.ts').includes('import-semantic-profile')],
  ['ipc restore', read('src-electron/modules/reqcase-shadow-recorder/ipc.ts').includes('restorePersistedSemanticProfile')],
  ['preload import', read('src-electron/preload.ts').includes('importSemanticProfile')],
  ['panel import btn', read('src-react/features/evidence/DefectEvidenceSettingsPanel.tsx').includes('导入画像')],
  ['panel template ok', read('src-react/features/evidence/DefectEvidenceSettingsPanel.tsx').includes('已导入并保存画像')],
  ['contracts type', read('types/contracts.ts').includes('SemanticProfileImportRecord')],
  ['settings sanitize', read('src-electron/modules/reqcase-shadow-recorder/settings-store.ts').includes('sanitizeSemanticProfileImport')],
  ['channels import', read('src-electron/modules/reqcase-shadow-recorder/ipc-channels.ts').includes('importSemanticProfile')],
];

let failed = 0;
for (const [name, ok] of checks) {
  console.log(ok ? 'PASS' : 'FAIL', name);
  if (!ok) failed += 1;
}

const panel = read('src-react/features/evidence/DefectEvidenceSettingsPanel.tsx');
const i = panel.indexOf('已导入并保存');
console.log('status snippet:', JSON.stringify(panel.slice(i, i + 160)));

// service method region
const service = read('src-electron/modules/reqcase-shadow-recorder/service.ts');
const j = service.indexOf('importSemanticProfileFromPath');
console.log('service method head:', service.slice(j, j + 200).replace(/\s+/g, ' '));

process.exit(failed ? 1 : 0);
