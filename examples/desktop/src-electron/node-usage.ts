import { ReqCaseShadowRecorderService } from './modules/reqcase-shadow-recorder';

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function demo(): Promise<void> {
  const service = new ReqCaseShadowRecorderService();

  service.setConfig({
    recordingWindowSeconds: 90,
    segmentDurationSeconds: 5,
    debounceMs: 90,
    webpQuality: 75,
    adaptiveQualityEnabled: true,
    adaptiveTargetImageKb: 100,
  });

  service.start();
  console.log('recording started... interact with apps for 5s');

  await sleep(5000);

  service.stop();
  const steps = service.getBuffer();
  console.log(`captured steps: ${steps.length}`);

  const report = await service.exportReport({
    targetDir: 'reports',
    title: 'ReqCase Module Report',
  });
  console.log('report:', report);

  if (steps[0]) {
    console.log('first step summary:', {
      id: steps[0].id,
      action: steps[0].action,
      processName: steps[0].processName,
      windowTitle: steps[0].windowTitle,
      at: new Date(steps[0].timestampMs).toISOString(),
    });
  }
}

void demo().catch((error) => {
  console.error('[node-usage] demo failed:', error);
  process.exitCode = 1;
});
