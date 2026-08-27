import { useState } from "react"

export default function SessionReactFixture() {
  const [value] = useState("Session React hook rendered")
  return <h1>{value}</h1>
}
