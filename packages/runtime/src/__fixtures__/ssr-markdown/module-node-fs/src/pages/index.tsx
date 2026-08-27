import { readFileSync } from "node:fs"

const hostContents = readFileSync("__HOST_SENTINEL_PATH__", "utf8")

export default function ModuleNodeFsFixture() {
  return <p>{hostContents}</p>
}
