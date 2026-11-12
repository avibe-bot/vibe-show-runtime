import { cpSync, existsSync, mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { isDeepStrictEqual } from "node:util"

export const runtimePackages = ["runtime", "ui", "sdk"]

export function bundleManifest(repoRoot) {
  const rootPackage = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"))
  const rootLock = JSON.parse(readFileSync(join(repoRoot, "package-lock.json"), "utf8"))
  const nodeEngine = rootPackage.engines?.node
  if (!nodeEngine) throw new Error("Missing root package engines.node")
  const dependencies = Object.fromEntries(runtimePackages.map((name) => [`@avibe/show-${name}`, `file:./packages/${name}`]))
  for (const name of ["@vitejs/plugin-react", "esbuild", "react", "react-dom", "vite"]) {
    const version = rootLock.packages?.[`node_modules/${name}`]?.version
    if (!version) throw new Error(`Missing locked package version for ${name}`)
    dependencies[name] = version
  }
  return { name: "avibe-show-runtime-distribution", private: true, type: "module", engines: { node: nodeEngine }, dependencies }
}

export function stageBundlePackages(repoRoot, stage, { built = true } = {}) {
  for (const name of runtimePackages) {
    const source = join(repoRoot, "packages", name)
    const target = join(stage, "packages", name)
    if (built && !existsSync(join(source, "dist"))) {
      throw new Error(`Missing built package: ${source}/dist. Run npm run build first.`)
    }
    mkdirSync(target, { recursive: true })
    cpSync(join(source, "package.json"), join(target, "package.json"))
    if (built) cpSync(join(source, "dist"), join(target, "dist"), { recursive: true })
  }
}

export function verifyBundleInputs(repoRoot, manifest, lock) {
  const sourceLock = JSON.parse(readFileSync(join(repoRoot, "package-lock.json"), "utf8"))
  const stale = (detail) => { throw new Error(`Stale distribution lock (${detail}); run npm run lock:bundle and review the diff.`) }
  if (!isDeepStrictEqual(manifest, bundleManifest(repoRoot))) stale("root manifest")
  if (lock.lockfileVersion !== 3 || !isDeepStrictEqual(lock.packages?.[""]?.dependencies, manifest.dependencies)) {
    stale("root lock")
  }
  // npm can trust a linked package's cached lock metadata rather than noticing
  // changed source requirements. Check those requirements before npm ci.
  for (const name of runtimePackages) {
    const source = JSON.parse(readFileSync(join(repoRoot, "packages", name, "package.json"), "utf8"))
    const locked = lock.packages?.[`packages/${name}`]
    const link = lock.packages?.[`node_modules/@avibe/show-${name}`]
    if (!locked || link?.link !== true || link.resolved !== `packages/${name}`) stale(`packages/${name} link`)
    for (const field of ["name", "version", "dependencies", "devDependencies", "optionalDependencies", "peerDependencies", "peerDependenciesMeta", "bundleDependencies", "bundledDependencies", "engines", "os", "cpu"]) {
      if (!isDeepStrictEqual(source[field], locked[field])) stale(`packages/${name} ${field}`)
    }
    const bin = source.bin && Object.fromEntries(Object.entries(source.bin).map(([name, path]) => [name, path.replace(/^\.\//, "")]))
    if (!isDeepStrictEqual(bin, locked.bin)) stale(`packages/${name} bin`)
  }
  const registryPinned = (entry) => !entry.link && entry.resolved?.startsWith("https://registry.npmjs.org/") && /^sha512-[A-Za-z0-9+/]{86}==$/.test(entry.integrity ?? "")
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (path === "" || runtimePackages.some((name) => path === `packages/${name}` || path === `node_modules/@avibe/show-${name}`)) continue
    // Some optional WASM packages ship bundled children. Those bytes are
    // covered by their enclosing registry tarball's integrity, not a second
    // download. Require an actual locked bundle owner rather than just trusting
    // an `inBundle` flag on an otherwise unpinned record.
    const bundled = entry.inBundle && !entry.link && !entry.resolved && Object.entries(lock.packages).some(([ownerPath, owner]) =>
      registryPinned(owner) && Array.isArray(owner.bundleDependencies) && owner.bundleDependencies.some((name) => {
        const prefix = `${ownerPath}/node_modules/${name}`
        return path === prefix || path.startsWith(`${prefix}/node_modules/`)
      })
    )
    if (!path.startsWith("node_modules/") || (!registryPinned(entry) && !bundled)) {
      stale(`unpinned registry package ${path}`)
    }
    if (registryPinned(entry)) {
      const source = sourceLock.packages?.[path]
      if (!source || ["version", "resolved", "integrity"].some((field) => source[field] !== entry[field])) {
        stale(`source dependency ${path}`)
      }
    }
  }
}
