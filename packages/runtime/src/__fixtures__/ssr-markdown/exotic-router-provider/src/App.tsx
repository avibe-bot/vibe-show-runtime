import { useSsrRouteLocation } from "./router"

export default function App() {
  const location = useSsrRouteLocation()
  const match = /^\/teams\/([^/]+)$/.exec(location.pathname)
  const team = match ? decodeURIComponent(match[1]) : "missing"
  const period = new URLSearchParams(location.search).get("period") ?? "missing"

  return (
    <main>
      <h1>Exotic provider team {team}</h1>
      <p>Period: {period}</p>
    </main>
  )
}
