import { reportDiagnostic } from '../services/diagnostics';

/** A capture failure must never leave a physical-contact slot occupied. */
export function capturePointerSafely(
  canvas: Pick<HTMLCanvasElement, 'setPointerCapture'>, pointerId: number, release: () => void,
): boolean {
  try {
    canvas.setPointerCapture(pointerId);
    return true;
  } catch (error) {
    release();
    reportDiagnostic(error, { operation: 'input.pointer_capture', reason: 'pointer_capture_failed',
      correlationId: `pointer-${pointerId}`, retryable: false, fallback: 'contact_released' });
    return false;
  }
}
