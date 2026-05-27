import { cn } from "./utils"

export function Progress({ value, className }: { value: number; className?: string }) {
  const bounded = Math.max(0, Math.min(100, value))
  return <div className={cn("avs-progress", className)}><span style={{ width: `${bounded}%` }} /></div>
}
