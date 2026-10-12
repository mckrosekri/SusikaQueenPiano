import type { BeatAnalysis } from '../types';
import { ANALYSIS_VERSION } from './analysis';
import { reportDiagnostic } from '../services/diagnostics';

interface AnalysisOptions {
  signal?: AbortSignal;
  onProgress?: (progress: number) => void;
}

interface WorkerProgress {
  type: 'progress';
  requestId: string;
  progress: number;
}

interface WorkerResult {
  type: 'result';
  requestId: string;
  analysis: BeatAnalysis;
}

interface WorkerFailure {
  type: 'error';
  requestId: string;
  code: string;
  errorClass: string;
  retryable: boolean;
}

type WorkerResponse = WorkerProgress | WorkerResult | WorkerFailure;

let requestSequence = 0;

function monoPcm(buffer: AudioBuffer): Float32Array {
  const output = new Float32Array(buffer.length);
  const channelCount = buffer.numberOfChannels;
  if (channelCount === 0) return output;
  for (let channel = 0; channel < channelCount; channel += 1) {
    const data = buffer.getChannelData(channel);
    for (let index = 0; index < output.length; index += 1) output[index] += data[index] / channelCount;
  }
  return output;
}

function abortError(): DOMException {
  return new DOMException('Audio analysis was cancelled.', 'AbortError');
}

export function analyzeAudioBuffer(
  buffer: AudioBuffer,
  audioHash: string,
  options: AnalysisOptions = {},
): Promise<BeatAnalysis> {
  if (options.signal?.aborted) return Promise.reject(abortError());
  const requestId = `analysis-${++requestSequence}`;
  const startedAt = performance.now();
  let pcm: Float32Array;
  try {
    pcm = monoPcm(buffer);
  } catch (cause) {
    reportDiagnostic(cause, {
      operation: 'audio_analysis',
      reason: 'audio_buffer_read_failed',
      retryable: false,
      correlationId: requestId,
      durationMs: Math.round(performance.now() - startedAt),
      analyzerVersion: ANALYSIS_VERSION,
    });
    const error = new Error('Audio data could not be prepared for analysis.');
    error.name = 'AudioAnalysisInputError';
    return Promise.reject(error);
  }

  return new Promise<BeatAnalysis>((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL('./analysis.worker.ts', import.meta.url), { type: 'module' });
    } catch (cause) {
      reportDiagnostic(cause, {
        operation: 'audio_analysis',
        reason: 'worker_initialization_failed',
        retryable: true,
        correlationId: requestId,
        durationMs: Math.round(performance.now() - startedAt),
        analyzerVersion: ANALYSIS_VERSION,
      });
      const error = new Error('Audio analysis worker could not start.');
      error.name = 'AudioAnalysisWorkerError';
      reject(error);
      return;
    }
    let settled = false;

    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener('abort', handleAbort);
      worker.terminate();
      action();
    };
    const handleAbort = (): void => finish(() => reject(abortError()));

    worker.addEventListener('message', (event: MessageEvent<WorkerResponse>) => {
      const message = event.data;
      if (!message || message.requestId !== requestId) return;
      if (message.type === 'progress') {
        options.onProgress?.(Math.min(1, Math.max(0, message.progress)));
      } else if (message.type === 'result') {
        finish(() => resolve(message.analysis));
      } else {
        const reason = ['invalid_audio_input', 'analysis_failed'].includes(message.code)
          ? message.code
          : 'analysis_failed';
        const exceptionClass = ['Error', 'TypeError', 'RangeError'].includes(message.errorClass)
          ? message.errorClass
          : 'Error';
        const error = new Error(`Audio analysis failed (${reason}).`);
        error.name = 'AudioAnalysisError';
        const diagnosticError = new Error();
        diagnosticError.name = exceptionClass;
        reportDiagnostic(diagnosticError, {
          operation: 'audio_analysis',
          reason,
          retryable: message.retryable,
          correlationId: requestId,
          durationMs: Math.round(performance.now() - startedAt),
          analyzerVersion: ANALYSIS_VERSION,
        });
        finish(() => reject(error));
      }
    });
    worker.addEventListener('error', () => {
      const error = new Error('Audio analysis worker failed.');
      error.name = 'AudioAnalysisWorkerError';
      reportDiagnostic(new Error(), {
        operation: 'audio_analysis',
        reason: 'worker_runtime_failure',
        retryable: true,
        correlationId: requestId,
        durationMs: Math.round(performance.now() - startedAt),
        analyzerVersion: ANALYSIS_VERSION,
      });
      finish(() => reject(error));
    });
    options.signal?.addEventListener('abort', handleAbort, { once: true });
    worker.postMessage(
      { type: 'analyze', requestId, pcm: pcm.buffer, sampleRate: buffer.sampleRate, audioHash },
      [pcm.buffer],
    );
  });
}
