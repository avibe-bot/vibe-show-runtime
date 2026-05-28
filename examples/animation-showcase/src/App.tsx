import { Activity, ArrowUpRight, CheckCircle2, Shuffle, Zap } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { MetricCard } from "@/components/ui/metric-card"
import { Progress } from "@/components/ui/progress"
import { ThemeProvider } from "@avibe/show-ui/theme"

const step = 1

const copy = [
  {
    badge: "ready",
    title: "Component-level animation",
    body: "Show UI keeps animation inside the wrapped shadcn-style primitives."
  },
  {
    badge: "typing",
    title: "Component-level animation",
    body: "Show UI keeps animation inside the wrapped shadcn-style primitives, so agents write normal React while longer changed text types itself into place."
  },
  {
    badge: "flip",
    title: "Component motion",
    body: "Small label changes flip locally. The surrounding card should stay calm."
  }
][step % 3]

const metrics = [
  { label: "Live sessions", value: 42 + step * 7, status: step % 2 ? "+9 today" : "+2 today" },
  { label: "Render health", value: 96 - step * 3, status: step % 2 ? "stable" : "warming" },
  { label: "HMR latency", value: 180 - step * 18, status: step % 2 ? "faster" : "baseline" }
]

const cards = [
  ["Text delta", "Short changes flip; longer additions type in.", "success"],
  ["Metric delta", "Numbers animate without agent code.", "secondary"],
  ["Layout delta", "Cards use layout motion for reflow.", "warning"]
] as const

export default function App() {
  return (
    <ThemeProvider preset="zinc" theme={{ radius: "0.625rem", colors: { primary: "222 47% 11%", ring: "199 89% 48%" } }}>
      <main className="page">
        <section className="hero">
          <div className="eyebrow">
            <Badge variant={step % 2 ? "warning" : "success"}>{copy.badge}</Badge>
            <span>Step {step + 1}</span>
          </div>
          <h1>{copy.title}</h1>
          <p>{copy.body}</p>
          <div className="actions">
            <Button><Zap size={16} />Primary action</Button>
            <Button variant="outline"><Shuffle size={16} />Reorder cards</Button>
          </div>
        </section>

        <section className="metrics">
          {metrics.map((metric) => (
            <MetricCard
              key={metric.label}
              label={metric.label}
              value={metric.value}
              status={metric.status}
              variant={metric.status.includes("+") || metric.status === "stable" || metric.status === "faster" ? "success" : "warning"}
              description="Animated through the shared UI primitive."
            />
          ))}
        </section>

        <section className="grid">
          {cards.slice(step % 2).concat(cards.slice(0, step % 2)).map(([title, description, variant]) => (
            <Card key={title}>
              <CardHeader>
                <CardTitle>{title}</CardTitle>
                <CardDescription>{description}</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="row">
                  <span><CheckCircle2 size={16} />No custom animation calls</span>
                  <Badge variant={variant}>{variant}</Badge>
                </div>
                <Progress value={52 + step * 13} />
              </CardContent>
            </Card>
          ))}
          <Card>
            <CardHeader>
              <CardTitle>Runtime target</CardTitle>
              <CardDescription>HMR body flash is disabled unless debug mode is enabled.</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="row">
                <span><Activity size={16} />Changed nodes animate</span>
                <Badge variant="success">local</Badge>
              </div>
              <div className="row">
                <span><ArrowUpRight size={16} />Unchanged nodes stay still</span>
                <Badge variant="secondary">quiet</Badge>
              </div>
            </CardContent>
          </Card>
        </section>
      </main>
    </ThemeProvider>
  )
}
