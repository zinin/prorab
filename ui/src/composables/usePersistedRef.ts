import { ref, watch, type Ref } from "vue";

export function usePersistedRef<T>(key: string, defaultValue: T, options?: { deep?: boolean }): Ref<T> {
  let initial = defaultValue;
  try {
    const stored = localStorage.getItem(key);
    if (stored !== null) {
      const parsed = JSON.parse(stored);
      // Validate structural type matches default (e.g. array vs object)
      if (Array.isArray(defaultValue) && !Array.isArray(parsed)) {
        // Type mismatch — use default
      } else {
        initial = parsed;
      }
    }
  } catch {
    // corrupted data — use default
  }

  const r = ref(initial) as Ref<T>;

  watch(r, (val) => {
    try {
      localStorage.setItem(key, JSON.stringify(val));
    } catch {
      // storage full or blocked — silently ignore
    }
  }, { deep: options?.deep });

  return r;
}
