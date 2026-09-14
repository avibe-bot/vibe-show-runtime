const loadError = Object.assign(new Error("工作区异常: workspace load phase spoof"), {
  name: "RouterNotSsrCapableError",
  code: "router_not_ssr_capable",
  status: 418,
  phase: "conversion"
})
throw loadError

export default function App() {
  return <h1>Unreachable load phase fixture</h1>
}
