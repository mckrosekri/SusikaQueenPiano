export interface DiagnosticContext {
  operation: string; reason?: string; retryable?: boolean; correlationId?: string;
  attempt?: number; durationMs?: number; fallback?: string; httpStatus?: number;
  provider?: string; providerRequestId?: string;
  analyzerVersion?: string; generatorVersion?: string;
}
export interface SafeDiagnostic {
  event: 'afterbeat.operation_failed'; reason: string; exceptionClass: string;
  operation: string; correlationId: string; retryable: boolean; attempt: number;
  at: number; durationMs?: number; httpStatus?: number; fallback?: string;
  provider?: string; providerRequestId?: string;
  analyzerVersion?: string; generatorVersion?: string;
}
const safeToken = (value: unknown, fallback: string) => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,80}$/.test(value) ? value : fallback;
const allowedNames = new Set(['Error','TypeError','RangeError','SyntaxError','DOMException','AbortError','NotSupportedError','QuotaExceededError','NotAllowedError','NotFoundError','InvalidStateError','DataError','EncodingError','SecurityError','NetworkError','TimeoutError']);
export interface OperationErrorOptions extends ErrorOptions {
  diagnostic?: Partial<Omit<DiagnosticContext, 'operation' | 'reason'>>;
}
export class OperationError extends Error {
  readonly diagnostic: Partial<Omit<DiagnosticContext, 'operation' | 'reason'>>;
  constructor(public readonly reason: string, public readonly operation: string, options: OperationErrorOptions = {}) {
    const { diagnostic = {}, ...errorOptions } = options;
    super(reason, errorOptions);
    this.name = 'OperationError';
    this.diagnostic = diagnostic;
  }
}
export function classifyDiagnostic(error: unknown, context: DiagnosticContext): SafeDiagnostic {
  let name = 'UnknownException'; let reason = context.reason;
  let inherited: Partial<Omit<DiagnosticContext, 'operation' | 'reason'>> = {};
  try {
    if (error instanceof OperationError) {
      name = 'OperationError'; reason = error.reason; inherited = error.diagnostic;
    }
    else if (error && typeof error === 'object') {
      const candidate = (error as {name?:unknown}).name;
      if (typeof candidate === 'string' && allowedNames.has(candidate)) name = candidate;
    }
  } catch { /* Inspection of hostile error objects must fail soft. */ }
  const classReason=({AbortError:'operation_cancelled',QuotaExceededError:'storage_quota_exceeded',NotSupportedError:'audio_codec_unsupported',EncodingError:'audio_decode_failed',NotAllowedError:'permission_denied',NetworkError:'network_unavailable',TimeoutError:'operation_timeout',SyntaxError:'stored_data_invalid',SecurityError:'storage_access_denied',InvalidStateError:'operation_state_invalid',DataError:'stored_data_invalid'} as Record<string,string>)[name];
  if(name!=='OperationError'&&classReason)reason=classReason;
  const effective = { ...inherited, ...context };
  reason ??= `${safeToken(context.operation,'operation').replaceAll('.','_')}_failed`;
  const d:SafeDiagnostic = { event:'afterbeat.operation_failed', reason:safeToken(reason,'operation_failed'), exceptionClass:name,
    operation:safeToken(context.operation,'unspecified'), correlationId:safeToken(effective.correlationId,`local-${Date.now().toString(36)}`), retryable:effective.retryable ?? ['NetworkError','TimeoutError'].includes(name), attempt:Math.max(1,Number.isFinite(effective.attempt) ? Math.floor(effective.attempt!) : 1), at:Date.now() };
  for (const key of ['durationMs','httpStatus'] as const) if (Number.isFinite(effective[key]) && effective[key]! >= 0) d[key] = effective[key];
  for (const key of ['fallback','provider','providerRequestId','analyzerVersion','generatorVersion'] as const) if (effective[key]) d[key] = safeToken(effective[key],'unavailable');
  return d;
}
export function reportDiagnostic(error: unknown, context: DiagnosticContext): SafeDiagnostic {
  const d = classifyDiagnostic(error, context);
  try { console.warn('[Afterbeat]', d); } catch { /* Preserve the original failure. */ }
  try {
    const key='afterbeat.diagnostics.v1'; const raw=JSON.parse(localStorage.getItem(key) ?? '[]');
    const entries=Array.isArray(raw) ? raw.filter(x=>x && x.event==='afterbeat.operation_failed').slice(-19) : [];
    localStorage.setItem(key,JSON.stringify([...entries,d]));
  } catch { /* Diagnostic persistence is best effort. */ }
  return d;
}
