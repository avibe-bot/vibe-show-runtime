import cssText from "./entry.css?inline"

export default function BoundaryCssFixture() {
  return <>
    <p>CSS import loaded</p>
    <pre>{cssText}</pre>
  </>
}
