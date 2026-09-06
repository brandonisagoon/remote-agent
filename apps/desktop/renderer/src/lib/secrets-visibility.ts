/** Global show/hide for all SecretFields, driven by the toggle-secrets chord. */
let visible = false;
const listeners = new Set<() => void>();

export function secretsVisible(): boolean {
  return visible;
}

export function toggleAllSecrets(): void {
  visible = !visible;
  listeners.forEach((listener) => listener());
}

export function subscribeSecrets(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
