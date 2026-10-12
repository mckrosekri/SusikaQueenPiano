import { describe, expect, it, vi } from 'vitest';
import { classifyDiagnostic, OperationError, reportDiagnostic } from './diagnostics';
describe('privacy-safe failure diagnostics',()=>{
  it('retains underlying safe exception and correlation without messages or payloads',()=>{
    const error=new DOMException('private/song.mp3 secret-token raw audio customer@email.test','QuotaExceededError');
    const d=classifyDiagnostic(error,{operation:'import.persist',correlationId:'scan-123',durationMs:22});
    expect(d).toMatchObject({exceptionClass:'QuotaExceededError',reason:'storage_quota_exceeded',correlationId:'scan-123',durationMs:22});
    expect(JSON.stringify(d)).not.toMatch(/secret|private\/|customer|raw audio/);
  });
  it('records stable operation reasons and versions',()=>{
    expect(classifyDiagnostic(new OperationError('audio_decode_failed','import.decode'),{operation:'import.decode',analyzerVersion:'fft-v1',attempt:2})).toMatchObject({exceptionClass:'OperationError',reason:'audio_decode_failed',attempt:2,analyzerVersion:'fft-v1'});
  });
  it('preserves safe provider metadata from the underlying operation without exposing unsafe values',()=>{
    const error=new OperationError('provider_http_failed','provider.request',{diagnostic:{provider:'incompetech',providerRequestId:'req-123',httpStatus:503,retryable:true}});
    expect(classifyDiagnostic(error,{operation:'outer.wrapper',correlationId:'job-456'})).toMatchObject({operation:'outer.wrapper',provider:'incompetech',providerRequestId:'req-123',httpStatus:503,retryable:true,correlationId:'job-456'});
    const unsafe=new OperationError('provider_http_failed','provider.request',{diagnostic:{provider:'secret provider payload',providerRequestId:'Bearer secret value'}});
    expect(classifyDiagnostic(unsafe,{operation:'outer.wrapper'})).toMatchObject({provider:'unavailable',providerRequestId:'unavailable'});
  });
  it('cannot throw over primary failures when logger and storage fail',()=>{
    const warning=vi.spyOn(console,'warn').mockImplementation(()=>{throw Error('logger broken');});
    vi.stubGlobal('localStorage',{getItem(){throw Error('storage broken');}});
    expect(()=>reportDiagnostic(new TypeError('secret'),{operation:'playback.start'})).not.toThrow();
    warning.mockRestore();vi.unstubAllGlobals();
  });
  it('does not inspect exception messages or unsafe names',()=>{
    const evil={get name(){throw Error('secret');},get message(){throw Error('secret');}};
    expect(classifyDiagnostic(evil,{operation:'decode'}).exceptionClass).toBe('UnknownException');
  });
  it.each(['analysis.bundle_load','audio.fetch','playback.start','library.delete','import.persist','progress.load','audio.dispose','feedback.haptic'])('retains a specific operation and safe failure class for %s',operation=>{
    const d=classifyDiagnostic(new TypeError('Bearer secret private audio'),{operation,correlationId:'run-456'});
    expect(d.reason).not.toBe('operation_failed');expect(d.exceptionClass).toBe('TypeError');expect(d.correlationId).toBe('run-456');expect(JSON.stringify(d)).not.toMatch(/Bearer|private audio|secret/);
  });
  it('preserves a specific service cause through a generic UI wrapper',()=>{expect(classifyDiagnostic(new OperationError('audio_file_too_large','import.validate'),{operation:'song_import',reason:'song_import_failed'}).reason).toBe('audio_file_too_large');expect(classifyDiagnostic(new DOMException('secret','QuotaExceededError'),{operation:'song_import',reason:'song_import_failed'}).reason).toBe('storage_quota_exceeded');});
});
