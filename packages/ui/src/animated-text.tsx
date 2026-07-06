import * as React from "react"
import { AnimatePresence, motion, useMotionValue, useReducedMotion, useTransform, animate } from "motion/react"

type TextMode = "stable" | "typewriter" | "flip" | "fade"

export function AnimatedText({ children, className }: { children: React.ReactNode; className?: string }) {
  const text = textFromChildren(children)
  const previous = usePrevious(text ?? undefined)
  const reduce = useReducedMotion()

  if (text === null) return <>{children}</>

  // Honor prefers-reduced-motion: render the text stably (no morph, typewriter, or caret).
  const mode = reduce ? "stable" : chooseMode(previous, text)
  if (mode === "stable") return <span className={className}>{text}</span>
  if (mode === "typewriter") return <TypewriterText className={className} text={text} />

  const variants =
    mode === "flip"
      ? {
          initial: { opacity: 0, y: 16, rotateX: -82, filter: "blur(2px)" },
          animate: { opacity: 1, y: 0, rotateX: 0, filter: "blur(0px)" },
          exit: { opacity: 0, y: -14, rotateX: 82, filter: "blur(2px)" }
        }
      : {
          initial: { opacity: 0, y: 8, filter: "blur(4px)" },
          animate: { opacity: 1, y: 0, filter: "blur(0px)" },
          exit: { opacity: 0, y: -6, filter: "blur(3px)" }
        }

  return (
    <span className={className} style={{ display: "inline-block", overflow: "hidden", perspective: 700, verticalAlign: "baseline" }}>
      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          key={text}
          initial="initial"
          animate="animate"
          exit="exit"
          variants={variants}
          transition={{ duration: mode === "flip" ? 0.38 : 0.28, ease: [0.16, 1, 0.3, 1] }}
          style={{ display: "inline-block", transformOrigin: "50% 55%" }}
        >
          {text}
        </motion.span>
      </AnimatePresence>
    </span>
  )
}

export function AnimatedNumber({
  value,
  format,
  className
}: {
  value: number
  format?: (value: number) => string
  className?: string
}) {
  const motionValue = useMotionValue(value)
  const rounded = useTransform(motionValue, (latest) => (format ? format(latest) : Math.round(latest).toLocaleString()))

  React.useEffect(() => {
    const controls = animate(motionValue, value, { duration: 0.72, ease: [0.16, 1, 0.3, 1] })
    return () => controls.stop()
  }, [motionValue, value])

  return <motion.span className={className}>{rounded}</motion.span>
}

function TypewriterText({ text, className }: { text: string; className?: string }) {
  const [display, setDisplay] = React.useState(text)

  React.useEffect(() => {
    setDisplay("")
    let index = 0
    const step = Math.max(1, Math.ceil(text.length / 84))
    const timer = window.setInterval(() => {
      index = Math.min(text.length, index + step)
      setDisplay(text.slice(0, index))
      if (index >= text.length) window.clearInterval(timer)
    }, 24)
    return () => window.clearInterval(timer)
  }, [text])

  return <span className={className}>{display}<span className="ml-[0.08em] inline-block h-[0.95em] w-[0.08em] min-w-0.5 translate-y-[0.12em] bg-current align-baseline animate-[avs-caret-blink_0.8s_steps(2,start)_infinite] motion-reduce:animate-none" /></span>
}

function chooseMode(previous: string | undefined, next: string): TextMode {
  if (previous === undefined || previous === next) return "stable"
  const diff = next.length - previous.length
  if (diff > 10) return "typewriter"
  if (Math.abs(diff) <= 10) return "flip"
  return "fade"
}

function textFromChildren(children: React.ReactNode): string | null {
  if (typeof children === "string" || typeof children === "number") return String(children)
  if (Array.isArray(children) && children.every((child) => typeof child === "string" || typeof child === "number")) return children.join("")
  return null
}

function usePrevious<T>(value: T): T | undefined {
  const ref = React.useRef<T | undefined>(undefined)
  React.useEffect(() => {
    ref.current = value
  }, [value])
  return ref.current
}
