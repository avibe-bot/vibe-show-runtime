import secret from "__BOUNDARY_IMPORT__"

export default function BoundaryHostFixture() {
  return <p>{secret}</p>
}
