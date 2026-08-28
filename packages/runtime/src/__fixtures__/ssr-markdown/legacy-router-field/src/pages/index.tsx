import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Link } from "../router"

function apiUrl(path: string) {
  const base = globalThis.__AVIBE_SHOW__?.basePath || "/"
  const baseUrl = new URL(base, window.location.origin)
  if (!baseUrl.pathname.endsWith("/")) baseUrl.pathname += "/"
  return new URL(path.replace(/^\/+/, ""), baseUrl).toString()
}

export default function HomePage() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Vibe Show Runtime</CardTitle>
        <CardDescription>This session is served by the managed service runtime.</CardDescription>
      </CardHeader>
      <CardContent className="flex items-center gap-3">
        <Button onClick={() => void fetch(apiUrl("api/health"))}>Call handler</Button>
        <Link className="text-sm underline" to="/second">Open second page</Link>
      </CardContent>
    </Card>
  )
}
