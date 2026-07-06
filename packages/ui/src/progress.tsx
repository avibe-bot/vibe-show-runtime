import { cn } from "./utils"

export function Progress({ value, className }: { value: number; className?: string }) {
  const bounded = Math.max(0, Math.min(100, value))
  return (
    <div className={cn("h-[0.5625rem] overflow-hidden rounded-full bg-muted", className)}>
      <span
        className="block h-full rounded-[inherit] bg-primary transition-[width] duration-300 ease-[cubic-bezier(0.2,0.8,0.2,1)] motion-reduce:transition-none"
        style={{ width: `${bounded}%` }}
      />
    </div>
  )
}
