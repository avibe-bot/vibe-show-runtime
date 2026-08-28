import { readFile } from "node:fs/promises"
import { join } from "node:path"

export async function GET(_request: Request, context: { session: { workspace: string } }) {
  const value = await readFile(join(context.session.workspace, "api", "value.txt"), "utf8")
  return Response.json({ value: value.trim() })
}
