import { useContext } from "react"
import { MotionConfigContext } from "motion/react"
import * as Router from "./router"

const windowDuringLoad = typeof window !== "undefined"

export function RouteContractPage({ params, query }) {
  const report = {
    pathname: Router.useRoutePath(),
    params,
    query: query ? Object.fromEntries(query) : null,
    exports: Object.fromEntries(
      ["useRoutePath", "Link", "navigate", "RouterView"].map(name => [name, typeof Router[name]])
    ),
    routes: Router.routes.map(route => ({
      path: route.path,
      dynamic: route.dynamic,
      segments: route.segments,
      sameComponent: route.Component === RouteContractPage
    })),
    windowDuringLoad,
    windowDuringRender: typeof window !== "undefined"
  }
  return (
    <main>
      <code>RouterContractReport:{JSON.stringify(report)}</code>
      <Router.Link to="/second">Second</Router.Link>
    </main>
  )
}

export function MotionContractPage() {
  const report = {
    isStatic: useContext(MotionConfigContext).isStatic,
    windowDuringLoad,
    windowDuringRender: typeof window !== "undefined"
  }
  return <code>RouterContractReport:{JSON.stringify(report)}</code>
}
