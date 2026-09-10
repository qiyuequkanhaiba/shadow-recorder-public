import type { ReqCaseShadowRecorderRendererApi } from '../src-electron/preload';

declare global {
  interface Window {
    reqcaseShadowRecorder: ReqCaseShadowRecorderRendererApi;
  }
}

export {};

