export class TimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} exceeded ${ms}ms timeout`);
    this.name = 'TimeoutError';
  }
}

/**
 * Reject with TimeoutError if `promise` doesn't settle within `ms`. The
 * underlying promise is not cancelled; callers holding resources (a browser,
 * a subprocess) must clean up in their own finally.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(label, ms)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}
