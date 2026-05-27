import type { VibeContext } from "@avibe/show-sdk"

export async function GET(_request: Request, context: VibeContext) {
  context.log.info("Serving session data")
  return Response.json({
    ok: true,
    sessionId: context.session.id
  })
}
