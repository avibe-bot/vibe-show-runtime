import * as router from "../src/router"

export function GET() {
  return Response.json({
    hasSsrRouterProvider: "SsrRouterProvider" in router,
    routes: router.routes.map(({ path, dynamic }) => ({ path, dynamic }))
  })
}
