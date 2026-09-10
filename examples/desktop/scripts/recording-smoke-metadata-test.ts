import { strict as assert } from 'node:assert';

import {
  createSmokeMatrixMetadata,
  resolveCaptureBackend,
  resolveDisplayMode,
  resolveDpiLabel,
  resolveEncoderName,
} from './recording-smoke-metadata';

function testDisplayMode(): void {
  assert.equal(resolveDisplayMode(0), 'none');
  assert.equal(resolveDisplayMode(1), 'single');
  assert.equal(resolveDisplayMode(2), 'dual');
  assert.equal(resolveDisplayMode(3), 'multi');
}

function testDpiLabel(): void {
  assert.equal(resolveDpiLabel([{ dpiScale: 1 }, { dpiScale: 1.5 }, { dpiScale: 1.5 }]), '100%,150%');
  assert.equal(resolveDpiLabel([]), 'unknown');
}

function testCaptureBackend(): void {
  assert.equal(resolveCaptureBackend({ wgcCaptureCount: 4, dxgiCaptureCount: 0 }, []), 'wgc');
  assert.equal(resolveCaptureBackend({ wgcCaptureCount: 0, dxgiCaptureCount: 3 }, []), 'dxgi');
  assert.equal(resolveCaptureBackend({ wgcCaptureCount: 1, dxgiCaptureCount: 1 }, []), 'mixed');
  assert.equal(resolveCaptureBackend({ wgcCaptureCount: 0, dxgiCaptureCount: 0 }, [{ captureBackend: 'wgc' }]), 'wgc');
  assert.equal(resolveCaptureBackend({ wgcCaptureCount: 0, dxgiCaptureCount: 0 }, [], [{ captureBackend: 'dxgi' }]), 'dxgi');
  assert.equal(resolveCaptureBackend({ wgcCaptureCount: 0, dxgiCaptureCount: 0 }, []), 'unknown');
}

function testEncoderName(): void {
  assert.equal(resolveEncoderName([{ encoderName: 'h264_nvenc' }, { encoderName: 'h264_nvenc' }]), 'h264_nvenc');
  assert.equal(resolveEncoderName([{ encoderName: 'libx264' }, { encoderName: 'h264_amf' }]), 'libx264,h264_amf');
  assert.equal(resolveEncoderName([]), 'unknown');
}

function testMatrixMetadata(): void {
  const metadata = createSmokeMatrixMetadata({
    mode: 'target_display',
    displays: [
      { displayId: '1' },
      { displayId: '2' },
    ],
    streams: [],
    segments: [{ encoderName: 'h264_nvenc' }],
    events: [{ dpiScale: 1.25, captureBackend: 'wgc' }],
    metrics: { wgcCaptureCount: 5, dxgiCaptureCount: 0 },
    osInfo: { type: 'Windows_NT', release: '10.0.22631', arch: 'x64' },
  });

  assert.deepEqual(metadata, {
    os: 'Windows_NT 10.0.22631',
    arch: 'x64',
    dpi: '125%',
    displayCount: 2,
    displayMode: 'dual',
    captureBackend: 'wgc',
    captureMode: 'target_display',
    encoder: 'h264_nvenc',
  });
}

function run(): void {
  testDisplayMode();
  testDpiLabel();
  testCaptureBackend();
  testEncoderName();
  testMatrixMetadata();
  console.log('[recording-smoke-metadata-test] PASS');
}

run();
