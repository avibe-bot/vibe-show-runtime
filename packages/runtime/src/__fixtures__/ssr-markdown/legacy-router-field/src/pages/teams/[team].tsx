import { Link } from "../../router"

export default function TeamPage({
  params,
  query
}: {
  params: Record<string, string>
  query?: URLSearchParams
}) {
  return (
    <main>
      <h1>Stock team {params.team}</h1>
      <p>Period: {query?.get("period") ?? "browser"}</p>
      <Link to="/">Back to home</Link>
    </main>
  )
}
