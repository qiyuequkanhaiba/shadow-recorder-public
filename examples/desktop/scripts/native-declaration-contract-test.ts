import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(__dirname, '../../..');
const desktopRoot = path.resolve(__dirname, '..');

function readRepo(relativePath: string): string {
  return readFileSync(path.resolve(repoRoot, relativePath), 'utf8');
}

function readDesktop(relativePath: string): string {
  return readFileSync(path.resolve(desktopRoot, relativePath), 'utf8');
}

function assertIncludes(source: string, snippet: string, label: string): void {
  assert.ok(source.includes(snippet), `${label} missing ${snippet}`);
}

function run(): void {
  const declaration = readDesktop('types/native-shadow-recorder.d.ts');
  const nativeBinding = readDesktop('src-electron/native-binding.ts');
  const rustLib = readRepo('src/lib.rs');
  const rustTypes = readRepo('src/types.rs');
  const buildRs = readRepo('build.rs');
  const windowsBuild = readRepo('scripts/windows-build-native.ps1');
  const operationContracts = readDesktop('types/operation-contracts.ts');

  assertIncludes(buildRs, 'napi_build::setup();', 'build.rs');
  assertIncludes(windowsBuild, 'cargo @buildArgs', 'windows-build-native.ps1 manual declaration strategy');

  for (const [rustExport, jsExport] of [
    ['get_test_session_operations', 'getTestSessionOperations'],
    ['rebuild_test_session_operations', 'rebuildTestSessionOperations'],
    ['update_test_session_operation', 'updateTestSessionOperation'],
  ] as const) {
    assertIncludes(rustLib, `pub fn ${rustExport}`, `Rust export ${rustExport}`);
    assertIncludes(declaration, jsExport, `manual native declaration ${jsExport}`);
    assertIncludes(nativeBinding, jsExport, `desktop native binding ${jsExport}`);
  }

  for (const snippet of [
    'ShadowRecorderNativeOperationTailResult',
    'ShadowRecorderNativeOperationCompatibilityDiagnostic',
    'diagnostics: ShadowRecorderNativeOperationCompatibilityDiagnostic[]',
    'lineNumber?: number',
    'schemaVersion?: number',
  ]) {
    assertIncludes(declaration, snippet, 'manual native declaration diagnostics');
  }

  assertIncludes(rustTypes, 'pub struct JsTestSessionOperationTailResult', 'Rust NAPI tail DTO');
  assertIncludes(rustTypes, 'pub diagnostics: Vec<JsOperationCompatibilityDiagnostic>', 'Rust NAPI diagnostics DTO');
  assertIncludes(operationContracts, 'TEST_SESSION_OPERATION_SCHEMA_VERSION', 'TypeScript operation schema constant');
  assertIncludes(operationContracts, 'TEST_SESSION_OPERATION_BUILDER_VERSION', 'TypeScript operation builder constant');

  console.log('[native-declaration-contract-test] PASS');
}

run();
