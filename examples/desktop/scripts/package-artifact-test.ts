import { strict as assert } from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { extractFile, listPackage } from '@electron/asar';

const desktopRoot = join(__dirname, '..');

function testBuilderDoesNotPackageRuntimeReports(): void {
  const packageJson = JSON.parse(readFileSync(join(desktopRoot, 'package.json'), 'utf8')) as {
    build?: { files?: string[] };
  };

  assert.ok(
    packageJson.build?.files?.some((pattern) => pattern === '!dist-electron/reports/**/*'),
    'electron-builder files must exclude dist-electron/reports runtime captures',
  );
}

function testAppAsarBootMetadataIsReadable(): void {
  const appAsarPath = join(desktopRoot, 'release/win-unpacked/resources/app.asar');
  assert.ok(existsSync(appAsarPath), `missing packaged app archive: ${appAsarPath}`);

  const entries = listPackage(appAsarPath, { isPack: false });
  assert.ok(entries.includes('\\package.json'), 'app.asar must contain root package.json');
  assert.ok(entries.includes('\\dist-electron\\src-electron\\main.js'), 'app.asar must contain Electron main entry');
  assert.ok(entries.includes('\\dist-react\\index.html'), 'app.asar must contain React index.html');
  assert.equal(
    entries.some((entry) => entry.startsWith('\\dist-electron\\reports\\')),
    false,
    'app.asar must not include runtime reports/test-sessions',
  );

  const packageJson = JSON.parse(extractFile(appAsarPath, 'package.json').toString('utf8')) as {
    main?: string;
    name?: string;
  };
  assert.equal(packageJson.name, 'shadow-recorder-desktop-example');
  assert.equal(packageJson.main, 'dist-electron/src-electron/main.js');

  const mainSource = extractFile(appAsarPath, 'dist-electron\\src-electron\\main.js').toString('utf8');
  assert.match(mainSource, /createMainWindow|BrowserWindow/);

  const indexHtml = extractFile(appAsarPath, 'dist-react\\index.html').toString('utf8');
  assert.match(indexHtml, /<div id="root"><\/div>/);
}

function run(): void {
  testBuilderDoesNotPackageRuntimeReports();
  testAppAsarBootMetadataIsReadable();
  console.log('[package-artifact-test] PASS');
}

run();
