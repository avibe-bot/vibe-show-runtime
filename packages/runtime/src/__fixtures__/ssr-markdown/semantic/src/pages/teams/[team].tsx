import { Link, type PageProps } from "../../router"

export default function TeamFixture({ params, query }: PageProps) {
  const period = query.get("period") ?? "missing"
  return (
    <main>
      <h1>Team {params.team}</h1>
      <p>Period: {period}</p>
      <Link to={`/teams/${params.team}/details?from=${period}`}>Open details</Link>
      <a href="?period=Q4">Change period</a>
    </main>
  )
}
