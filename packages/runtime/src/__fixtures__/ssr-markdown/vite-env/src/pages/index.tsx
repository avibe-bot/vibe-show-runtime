export default function ViteEnvironmentFixture() {
  const customEnvironmentEnabled = import.meta.env.VITE_API_ORIGIN ===
    "https://api.example.test/v1/"
  return (
    <main>
      <h1>Vite environment fixture</h1>
      <a href={`${import.meta.env.BASE_URL}guide`}>Environment base link</a>
      <img
        src={`${import.meta.env.BASE_URL}assets/chart.png`}
        alt="Environment base asset"
      />
      <p>MODE: {import.meta.env.MODE}</p>
      <p>DEV: {String(import.meta.env.DEV)}</p>
      <p>PROD: {String(import.meta.env.PROD)}</p>
      <p>SSR: {String(import.meta.env.SSR)}</p>
      <p>
        Custom environment branch: {customEnvironmentEnabled ? "enabled" : "disabled"}
      </p>
      <a href={new URL("reports", import.meta.env.VITE_API_ORIGIN).href}>
        Custom environment URL
      </a>
      <p>
        Host environment visible: {String(
          import.meta.env.AVIBE_SSR_HOST_ONLY_ORIGIN !== undefined
        )}
      </p>
    </main>
  )
}
