import type { ViteDevServer } from "vite"

const invalidators = new WeakMap<ViteDevServer, () => void>()

export function registerSsrModuleValidationInvalidator(
  vite: ViteDevServer,
  invalidate: () => void
): void {
  invalidators.set(vite, invalidate)
}

export function invalidateSsrModuleValidationCache(vite: ViteDevServer): void {
  invalidators.get(vite)?.()
}
