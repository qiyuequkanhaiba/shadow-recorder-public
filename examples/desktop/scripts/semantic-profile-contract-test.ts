import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

function main(): void {
  const samplePath = path.join(__dirname, '../semantic-profile.sample.json');
  const fixturePath = path.join(
    __dirname,
    '../../../tests/fixtures/semantic-profiles/qttimer-cc3-mini.json',
  );
  const sample = JSON.parse(readFileSync(samplePath, 'utf8'));
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));

  assert.equal(sample.schemaVersion, 1);
  assert.ok(sample.profileId);
  assert.ok(sample.targetProcessName);
  assert.ok(Array.isArray(sample.aliasRules) && sample.aliasRules.length > 0);
  assert.ok(Array.isArray(sample.scenarioRules) && sample.scenarioRules.length > 0);

  assert.equal(fixture.profileId, 'cc3-mini');
  assert.equal(fixture.targetProcessName, 'QtApp.exe');
  assert.ok(fixture.aliasRules.some((rule: any) => rule.automationId));
  assert.ok(
    fixture.scenarioRules.some(
      (rule: any) => rule.triggerActionAlias && rule.primaryTargetAlias,
    ),
  );

  const rustSource = readFileSync(
    path.join(__dirname, '../../../src/session/semantic_profile.rs'),
    'utf8',
  );
  assert.match(rustSource, /parse_semantic_profile_json/);
  assert.match(rustSource, /match_scenario_completion/);
  assert.match(rustSource, /persist_semantic_profile_snapshot/);

  const libSource = readFileSync(path.join(__dirname, '../../../src/lib.rs'), 'utf8');
  assert.match(libSource, /load_semantic_profile/);
  assert.match(libSource, /get_semantic_profile_json/);

  const contractsSource = readFileSync(path.join(__dirname, '../types/contracts.ts'), 'utf8');
  assert.match(contractsSource, /SemanticProfileImportRecord/);
  assert.match(contractsSource, /semanticProfile\?/);

  const settingsStore = readFileSync(
    path.join(__dirname, '../src-electron/modules/reqcase-shadow-recorder/settings-store.ts'),
    'utf8',
  );
  assert.match(settingsStore, /sanitizeSemanticProfileImport/);

  const ipcSource = readFileSync(
    path.join(__dirname, '../src-electron/modules/reqcase-shadow-recorder/ipc.ts'),
    'utf8',
  );
  assert.match(ipcSource, /import-semantic-profile/);
  assert.match(ipcSource, /restorePersistedSemanticProfile/);

  console.log('semantic-profile-contract-test: ok');
}

main();
