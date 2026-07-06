import * as React from "react"
import { AnimatedNumber } from "./animated-text"
import { Badge, type BadgeVariant } from "./badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./card"

export function MetricCard({
  label,
  value,
  format,
  status,
  variant = "secondary",
  description,
  className
}: {
  label: React.ReactNode
  value: number
  format?: (value: number) => string
  status?: React.ReactNode
  variant?: BadgeVariant
  description?: React.ReactNode
  className?: string
}) {
  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle>{label}</CardTitle>
        {description ? <CardDescription>{description}</CardDescription> : null}
      </CardHeader>
      <CardContent>
        <div className="flex items-baseline gap-1 text-[2rem] font-extrabold leading-none text-foreground">
          <AnimatedNumber value={value} format={format} />
        </div>
        {status ? (
          <div className="mt-3 flex items-center justify-between gap-3">
            <Badge variant={variant}>{status}</Badge>
          </div>
        ) : null}
      </CardContent>
    </Card>
  )
}
