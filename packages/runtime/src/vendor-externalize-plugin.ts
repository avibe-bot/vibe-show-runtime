import type { Plugin } from "vite"
import type { Plugin as EsbuildPlugin } from "esbuild"

/**
 * Leave the shared "provided" vendor specifiers as **bare** specifiers in every
 * served dev module so a browser import map (added on the serving side) resolves
 * them to the one shared, content-hashed vendor bundle (Stage R-A) — i.e. one
 * React instance across every Show Page session.
 *
 * Vite dev does NOT externalize as cleanly as a production build: a plugin
 * `resolveId` that returns `{ id, external: true }` is honored, but dev
 * import-analysis still rewrites the import to `<base>/@id/<spec>` (it wraps any
 * non-relative, non-absolute resolved id via `wrapId`). So externalizing in dev
 * takes three coordinated moves — the same recipe `vite-plugin-externalize-
 * dependencies` uses, inlined here so we don't add a dependency:
 *
 *   1. `resolveId` returns the provided specifiers as external (and `load`
 *      returns a stub) so Vite stops trying to resolve/serve them.
 *   2. The dep optimizer is told to leave them alone — they're removed from
 *      `optimizeDeps.include`, added to `optimizeDeps.exclude`, AND an esbuild
 *      scan/optimize plugin marks them external so the scanner never crawls into
 *      them (mirrors `optimizeDeps.esbuildOptions.plugins`).
 *   3. A late `transform` pass rewrites the `<base>/@id/<spec>` form that dev
 *      import-analysis emits back to the original bare `<spec>` in the served
 *      code, so the browser sees `import ... from "react"`.
 *
 * The provided set is **exact-matched**: it's exactly the specifiers the bundle +
 * import map cover (the `vendor-manifest.json` `specifiers`, passed in by the
 * runtime). Exact match is essential — prefix-matching `@avibe/show-ui/` would
 * externalize a deep subpath the import map does NOT cover (e.g. a non-enumerated
 * `@avibe/show-ui/...`), leaving a bare import the browser can't resolve. A subpath
 * outside the provided set instead optimizes per-session normally (safe).
 */
export function createVendorExternalizePlugins(providedSpecifiers: string[]): Plugin[] {
  return [externalizePlugin(createProvidedMatcher(providedSpecifiers))]
}

/**
 * Whether a specifier belongs to the provided vendor set and must be left bare for
 * the import map. Exact match against the provided specifiers (the bundle's manifest
 * list). Exported so callers (e.g. `optimizeDeps` config, declared-extras filtering)
 * filter the provided set out with the same logic.
 */
export function isProvidedVendorSpecifier(specifier: string, providedSpecifiers: string[]): boolean {
  return createProvidedMatcher(providedSpecifiers).matches(specifier)
}

/** Exact-match the provided JS/CSS specifiers (the manifest's authoritative set). */
export interface ProvidedMatcher {
  /** Every provided specifier (JS + CSS), used for `optimizeDeps.exclude`. */
  readonly specifiers: string[]
  matches(specifier: string): boolean
}

function createProvidedMatcher(providedSpecifiers: string[]): ProvidedMatcher {
  const specifiers = [...providedSpecifiers]
  const exact = new Set(specifiers)
  return {
    specifiers,
    matches(specifier: string) {
      return exact.has(cleanSpecifier(specifier))
    }
  }
}

/** Strip Vite's query/hash suffix (`?v=...`, `?import`, `#...`) before matching. */
function cleanSpecifier(specifier: string): string {
  const queryIndex = specifier.search(/[?#]/)
  return queryIndex === -1 ? specifier : specifier.slice(0, queryIndex)
}

function externalizePlugin(matcher: ProvidedMatcher): Plugin {
  return {
    name: "avibe-show-vendor-externalize",
    enforce: "pre",
    apply: "serve",
    config(config) {
      // Belt-and-suspenders: even with `resolveId` external, keep the optimizer
      // from scanning/pre-bundling the provided set. Exclude them, drop them from
      // any `include`, and mark them external in the esbuild scan/optimize pass.
      config.optimizeDeps ??= {}
      const exclude = new Set(config.optimizeDeps.exclude ?? [])
      for (const specifier of matcher.specifiers) exclude.add(specifier)
      config.optimizeDeps.exclude = [...exclude]
      if (config.optimizeDeps.include) {
        config.optimizeDeps.include = config.optimizeDeps.include.filter((entry) => !includesProvided(entry, matcher))
      }
      config.optimizeDeps.esbuildOptions ??= {}
      const plugins = (config.optimizeDeps.esbuildOptions.plugins ??= [])
      if (!plugins.some((plugin) => plugin.name === ESBUILD_EXTERNALIZE_NAME)) {
        plugins.push(esbuildExternalizePlugin(matcher))
      }
    },
    configResolved(config) {
      // `vite:import-analysis` runs *after* every user plugin (even `enforce:
      // "post"`), so it rewrites our externalized imports to `<base>/@id/<spec>`
      // last. Appending the bare-rewrite pass onto the already-resolved plugin
      // array is the only place it runs *after* import-analysis, so it can strip
      // the `/@id/` wrapping back to the bare specifier. (Cast: `plugins` is
      // typed readonly on ResolvedConfig but is the live array Vite iterates.)
      ;(config.plugins as Plugin[]).push(bareRewritePlugin(matcher, config.base ?? "/"))
    },
    resolveId(source) {
      if (matcher.matches(source)) {
        return { id: source, external: true }
      }
      return null
    },
    load(id) {
      // External ids are not normally loaded, but a stub keeps Vite from logging
      // "could not be resolved" if anything reaches the load hook.
      if (matcher.matches(id)) {
        return "export default {}"
      }
      return null
    }
  }
}

const ESBUILD_EXTERNALIZE_NAME = "avibe-show-vendor-externalize"

/**
 * esbuild plugin for the dep optimizer's scan + optimize passes: mark provided
 * specifiers external (so the scanner stops at them) and serve an empty module
 * for any that slip through as an entry point.
 */
function esbuildExternalizePlugin(matcher: ProvidedMatcher): EsbuildPlugin {
  return {
    name: ESBUILD_EXTERNALIZE_NAME,
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        if (!matcher.matches(args.path)) return null
        if (args.kind === "entry-point") {
          return { path: args.path, namespace: ESBUILD_EXTERNALIZE_NAME }
        }
        return { path: args.path, external: true }
      })
      build.onLoad({ filter: /.*/, namespace: ESBUILD_EXTERNALIZE_NAME }, () => ({ contents: "" }))
    }
  }
}

/**
 * Late `transform` pass (appended onto the resolved plugin array so it runs
 * *after* `vite:import-analysis`): import-analysis rewrites an externalized
 * import to `<base>/@id/<spec>`. Rewrite that form back to the original bare
 * `<spec>` so the browser keeps `import ... from "react"` for the import map.
 */
function bareRewritePlugin(matcher: ProvidedMatcher, base: string): Plugin {
  const pattern = buildBareRewritePattern(base)
  return {
    name: "avibe-show-vendor-bare-rewrite",
    transform(code) {
      if (!code.includes("/@id/")) return null
      pattern.lastIndex = 0
      let mutated = false
      const next = code.replace(pattern, (match, _quote: string, specifier: string) => {
        const decoded = decodeIdSpecifier(specifier)
        if (!matcher.matches(decoded)) return match
        mutated = true
        return JSON.stringify(decoded)
      })
      return mutated ? { code: next, map: null } : null
    }
  }
}

/**
 * Match the quoted, base-prefixed `/@id/<spec>` URL Vite emits for an externalized
 * import. The specifier may carry a `__x00__`-encoded null byte or a `?import`
 * query that import-analysis appends; capture the raw inner and decode/clean it
 * before checking membership.
 */
function buildBareRewritePattern(base: string): RegExp {
  const normalizedBase = base.endsWith("/") ? base.slice(0, -1) : base
  const prefix = `${escapeRegExp(normalizedBase)}/@id/`
  return new RegExp(`(["'])${prefix}([^"'\\\\]+)\\1`, "g")
}

function decodeIdSpecifier(raw: string): string {
  // Vite encodes a leading null byte (virtual modules) as `__x00__`; provided
  // specifiers never contain one, but decode defensively before cleaning.
  return cleanSpecifier(raw.replace(/^__x00__/, "\0"))
}

function includesProvided(entry: string, matcher: ProvidedMatcher): boolean {
  // `optimizeDeps.include` entries can be nested ("a > b > react"); the actual
  // optimized specifier is the last segment.
  const last = entry.split(">").pop()?.trim() ?? entry
  return matcher.matches(last)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
