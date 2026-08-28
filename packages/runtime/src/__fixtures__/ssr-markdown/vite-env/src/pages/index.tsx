export default function ViteEnvironmentFixture() {
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
    </main>
  )
}
