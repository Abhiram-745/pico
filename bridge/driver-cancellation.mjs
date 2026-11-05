/** Scope every model entry point, including calls made by driver helpers. */
export function cancellableModel(llm, signal) {
  if (!signal) return llm;
  const methods = new Set(['respond', 'chat', 'evaluate', 'toolCall', 'stream', 'plan']);
  return new Proxy(llm, {
    get(target, key) {
      const value = Reflect.get(target, key);
      if (!methods.has(key) || typeof value !== 'function') return value;
      return async (...args) => {
        signal.throwIfAborted();
        const index = key === 'respond' ? 0 : key === 'evaluate' ? 2 : 1;
        const options = args[index] ?? {};
        const combined = options.signal ? AbortSignal.any([signal, options.signal]) : signal;
        args[index] = { ...options, signal: combined };
        const result = await value.apply(target, args);
        // Providers and test doubles may ignore cancellation and return late.
        combined.throwIfAborted();
        return result;
      };
    },
  });
}
