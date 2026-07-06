import { Activity, CheckCircle2, Server } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Progress } from "@/components/ui/progress"
import { ThemeProvider } from "@avibe/show-ui/theme"

export default function App() {
  return (
    <ThemeProvider preset="zinc">
      <main className="page">
        <section className="hero">
          <Badge variant="success">shadcn alias</Badge>
          <h1>Agent-friendly Show UI</h1>
          <p>Imports use normal shadcn paths, while Vite resolves them to @avibe/show-ui.</p>
          <span className="inline-flex items-center gap-2 rounded-md bg-emerald-500/10 px-3 py-1 text-sm font-medium text-emerald-700">
            Tailwind utility classes are built in
          </span>
          <Button className="bg-emerald-600 text-white">A utility className overrides the component default</Button>
        </section>
        <section className="grid">
          <Card>
            <CardHeader>
              <CardTitle>Runtime health</CardTitle>
              <CardDescription>Shared UI package with session-local code.</CardDescription>
            </CardHeader>
            <CardContent className="stack">
              <div className="row"><span><Server size={16} /> Vite context</span><Badge variant="success">active</Badge></div>
              <Progress value={68} />
              <Progress value={42} />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Agent workflow</CardTitle>
              <CardDescription>No component copy step is needed.</CardDescription>
            </CardHeader>
            <CardContent className="stack">
              {["Write React", "Use '@/components/ui/button'", "Runtime aliases imports"].map((item) => (
                <div className="row" key={item}><span><CheckCircle2 size={16} /> {item}</span></div>
              ))}
              <Dialog>
                <DialogTrigger asChild><Button>Open details</Button></DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Alias resolved</DialogTitle>
                    <DialogDescription>The page imports from shadcn-style paths. The runtime owns the implementation and dependencies.</DialogDescription>
                  </DialogHeader>
                  <div className="row"><span><Activity size={16} /> Bundle source</span><Badge variant="secondary">@avibe/show-ui</Badge></div>
                </DialogContent>
              </Dialog>
            </CardContent>
          </Card>
        </section>
      </main>
    </ThemeProvider>
  )
}
