import { describe, expect, test, vi } from 'vitest';

import { Emitter } from './emitter.ts';

describe('a throwing error handler does not unwind into the edit either', () => {
  // A listener that throws is routed to onError, so the edit that emitted can
  // finish. An onError that itself threw escaped from that catch: the edit
  // threw to its caller after the document had already changed, and the
  // `history` event that follows it never fired.
  test('the remaining listeners still run, and emit returns normally', () => {
    const report = vi.spyOn(console, 'error').mockImplementation(() => {});
    const emitter = new Emitter<{ change: number }>();
    emitter.setErrorHandler(() => {
      throw new Error('onError is broken too');
    });
    const later = vi.fn<(value: number) => void>();
    emitter.on('change', () => {
      throw new Error('listener');
    });
    emitter.on('change', later);

    expect(() => emitter.emit('change', 1)).not.toThrow();
    expect(later).toHaveBeenCalledWith(1);
    expect(report).toHaveBeenCalled();
    report.mockRestore();
  });
});

describe('has() answers whether a payload is worth building', () => {
  test('false with no listener, true with one, false again after unsubscribing', () => {
    const emitter = new Emitter<{ change: number }>();

    expect(emitter.has('change')).toBe(false);
    const off = emitter.on('change', () => {});
    expect(emitter.has('change')).toBe(true);
    off();
    expect(emitter.has('change')).toBe(false);
  });
});
