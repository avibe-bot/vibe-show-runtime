const deferredCallbacks: string[] = []
const channel = new MessageChannel()
channel.port1.onmessage = () => deferredCallbacks.push("message-channel")

setInterval(() => {
  deferredCallbacks.push("interval")
  queueMicrotask(() => deferredCallbacks.push("microtask"))
  channel.port2.postMessage("deferred")
}, 2_000)

setInterval(() => {
  while (true) Math.random()
}, 2_100)

export default function ScheduledWorkFixture() {
  return (
    <main>
      <h1>Scheduled work fixture</h1>
      <p>The initial tree rendered before the interval fired.</p>
      <p>Deferred callbacks: {deferredCallbacks.join(", ") || "none"}</p>
    </main>
  )
}
