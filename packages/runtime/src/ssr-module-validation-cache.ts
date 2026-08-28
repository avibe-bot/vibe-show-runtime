import type { ViteDevServer } from "vite"

const invalidators = new WeakMap<ViteDevServer, (changedPath?: string) => void>()

export function registerSsrModuleValidationInvalidator(
  vite: ViteDevServer,
  invalidate: (changedPath?: string) => void
): void {
  invalidators.set(vite, invalidate)
}

export function invalidateSsrModuleValidationCache(
  vite: ViteDevServer,
  changedPath?: string
): void {
  invalidators.get(vite)?.(changedPath)
}
