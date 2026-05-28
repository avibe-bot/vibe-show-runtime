import * as React from "react"
import { AnimatePresence, motion } from "motion/react"

type TextMode = "stable" | "typewriter" | "flip" | "fade"

export function AnimatedText({ children, className }: { children: React.ReactNode; className?: string }) {
  const text = textFromChildren(children)
  const previous = usePrevious(text ?? undefined)

  if (text === null) {
    return <>{children}</>
  }

  const mode = chooseMode(previous, text)

  if (mode === "typewriter") {
    return <TypewriterText className={className} text={text} />
  }

  if (mode === "stable") {
    return <span className={className}>{text}</span>
  }

  const variants =
    mode === "flip"
      ? {
          initial: { opacity: 0, y: 10, rotateX: -70 },
          animate: { opacity: 1, y: 0, rotateX: 0 },
          exit: { opacity: 0, y: -8, rotateX: 70 }
        }
      : {
          initial: { opacity: 0, y: 4 },
          animate: { opacity: 1, y: 0 },
          exit: { opacity: 0, y: -4 }
        }

  return (
    <span className={className} style={{ display: "inline-block", perspective: 600 }}>
      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          key={text}
          initial="initial"
          animate="animate"
          exit="exit"
          variants={variants}
          transition={{ duration: mode === "flip" ? 0.24 : 0.18, ease: [0.2, 0.8, 0.2, 1] }}
          style={{ display: "inline-block", transformOrigin: "50% 55%" }}
        >
          {text}
        </motion.span>
      </AnimatePresence>
    </span>
  )
}

function TypewriterText({ text, className }: { text: string; className?: string }) {
  const [display, setDisplay] = React.useState(text)

  React.useEffect(() => {
    setDisplay("")
    let index = 0
    const step = Math.max(1, Math.ceil(text.length / 54))
    const timer = window.setInterval(() => {
      index = Math.min(text.length, index + step)
      setDisplay(text.slice(0, index))
      if (index >= text.length) {
        window.clearInterval(timer)
      }
    }, 18)
    return () => window.clearInterval(timer)
  }, [text])

  return <span className={className}>{display}</span>
}

function chooseMode(previous: string | undefined, next: string): TextMode {
  if (previous === undefined || previous === next) return "stable"
  const diff = next.length - previous.length
  if (diff > 10 && next.startsWith(previous.slice(0, Math.min(previous.length, 16)))) return "typewriter"
  if (Math.abs(diff) <= 10) return "flip"
  return "fade"
}

function textFromChildren(children: React.ReactNode): string | null {
  if (typeof children === "string" || typeof children === "number") return String(children)
  if (Array.isArray(children) && children.every((child) => typeof child === "string" || typeof child === "number")) {
    return children.join("")
  }
  return null
}

function usePrevious<T>(value: T): T | undefined {
  const ref = React.useRef<T | undefined>(undefined)
  React.useEffect(() => {
    ref.current = value
  }, [value])
  return ref.current
}
