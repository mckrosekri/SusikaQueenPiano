/// <reference lib="webworker" />

import { analyzePCM } from './analysis';

interface AnalyzeMessage {
  type: 'analyze';
  requestId: string;
  pcm: ArrayBuffer;
  sampleRate: number;
  audioHash: string;
}

const worker = self as DedicatedWorkerGlobalScope;

worker.addEventListener('message', (event: MessageEvent<AnalyzeMessage>) => {
  const message = event.data;
  if (!message || message.type !== 'analyze') return;

  try {
    const analysis = analyzePCM(new Float32Array(message.pcm), message.sampleRate, message.audioHash, (progress) => {
      worker.postMessage({ type: 'progress', requestId: message.requestId, progress });
    });
    worker.postMessage({ type: 'result', requestId: message.requestId, analysis });
  } catch (error) {
    worker.postMessage({
      type: 'error',
      requestId: message.requestId,
      code: error instanceof RangeError || error instanceof TypeError ? 'invalid_audio_input' : 'analysis_failed',
      errorClass: error instanceof Error ? error.name : 'UnknownError',
      retryable: false,
    });
  }
});

export {};
