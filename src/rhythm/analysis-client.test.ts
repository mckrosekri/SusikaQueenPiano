import { afterEach, describe, expect, it, vi } from 'vitest';

import { reportDiagnostic } from '../services/diagnostics';
import { analyzeAudioBuffer } from './analysis-client';

vi.mock('../services/diagnostics', () => ({ reportDiagnostic: vi.fn() }));

type Listener = (event: MessageEvent | Event) => void;

class FakeWorker {
  protected readonly listeners = new Map<string, Listener[]>();

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  postMessage(message: { requestId: string }): void {
    queueMicrotask(() => {
      const response = new MessageEvent('message', {
        data: {
          type: 'error',
          requestId: message.requestId,
          code: 'invalid_audio_input',
          errorClass: 'RangeError',
          retryable: false,
        },
      });
      this.listeners.get('message')?.forEach((listener) => listener(response));
    });
  }

  terminate(): void {}
}

class RuntimeFailureWorker extends FakeWorker {
  override postMessage(): void {
    queueMicrotask(() => {
      this.listeners.get('error')?.forEach((listener) => listener(new Event('error')));
    });
  }
}

class ConstructorFailureWorker {
  constructor() {
    throw new Error('private runtime path');
  }
}

function fakeAudioBuffer(): AudioBuffer {
  const samples = new Float32Array([0.25, -0.25, 0.5]);
  return {
    length: samples.length,
    numberOfChannels: 1,
    sampleRate: 44_100,
    getChannelData: () => samples,
  } as unknown as AudioBuffer;
}

describe('analyzeAudioBuffer diagnostics', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('reports a structured safe worker failure without PCM or an audio hash', async () => {
    vi.stubGlobal('Worker', FakeWorker);

    await expect(analyzeAudioBuffer(fakeAudioBuffer(), 'private-audio-hash')).rejects.toThrow(
      'Audio analysis failed (invalid_audio_input).',
    );
    expect(reportDiagnostic).toHaveBeenCalledOnce();
    const [error, context] = vi.mocked(reportDiagnostic).mock.calls[0];
    expect(error).toMatchObject({ name: 'RangeError' });
    expect(context).toMatchObject({
      operation: 'audio_analysis',
      reason: 'invalid_audio_input',
      retryable: false,
      analyzerVersion: 'afterbeat-analysis-v2',
    });
    expect(JSON.stringify([error, context])).not.toContain('private-audio-hash');
    expect(JSON.stringify([error, context])).not.toContain('0.25');
  });

  it('reports worker runtime and initialization failures with stable reasons', async () => {
    vi.stubGlobal('Worker', RuntimeFailureWorker);
    await expect(analyzeAudioBuffer(fakeAudioBuffer(), 'private-audio-hash')).rejects.toThrow(
      'Audio analysis worker failed.',
    );
    expect(reportDiagnostic).toHaveBeenLastCalledWith(
      expect.any(Error),
      expect.objectContaining({ reason: 'worker_runtime_failure', retryable: true }),
    );

    vi.stubGlobal('Worker', ConstructorFailureWorker);
    await expect(analyzeAudioBuffer(fakeAudioBuffer(), 'private-audio-hash')).rejects.toThrow(
      'Audio analysis worker could not start.',
    );
    expect(reportDiagnostic).toHaveBeenLastCalledWith(
      expect.any(Error),
      expect.objectContaining({ reason: 'worker_initialization_failed', retryable: true }),
    );
  });

  it('reports buffer read failures and returns a sanitized public error', async () => {
    const brokenBuffer = {
      length: 1,
      numberOfChannels: 1,
      sampleRate: 44_100,
      getChannelData: () => {
        throw new Error('private sample detail');
      },
    } as unknown as AudioBuffer;

    await expect(analyzeAudioBuffer(brokenBuffer, 'private-audio-hash')).rejects.toThrow(
      'Audio data could not be prepared for analysis.',
    );
    expect(reportDiagnostic).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ reason: 'audio_buffer_read_failed', retryable: false }),
    );
  });
});
