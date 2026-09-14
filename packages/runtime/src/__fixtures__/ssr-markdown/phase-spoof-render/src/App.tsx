export default function App() {
  const renderError = Object.assign(new Error("工作区异常: workspace render phase spoof"), {
    name: "RouterNotSsrCapableError",
    code: "router_not_ssr_capable",
    status: 418,
    phase: "cleanup"
  })
  throw renderError
}
