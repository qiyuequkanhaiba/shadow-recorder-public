import type { RecorderMetrics, RecorderPersistedSettings } from '../../types/contracts';
import type { RecorderBootstrapSnapshot } from './useRecorderBootstrapBindings';

export async function loadRecorderBootstrapSnapshot(): Promise<RecorderBootstrapSnapshot> {
  const [latestMetrics, settings] = await Promise.all([
    window.reqcaseShadowRecorder.getMetrics().catch(() => null),
    window.reqcaseShadowRecorder.getSettings(),
  ]);

  return {
    buffer: [],
    latestMetrics: latestMetrics as RecorderMetrics | null,
    settings: settings as RecorderPersistedSettings | null | undefined,
  };
}
