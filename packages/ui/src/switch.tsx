export function Switch({
  checked,
  onCheckedChange,
  label
}: {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  label?: string
}) {
  return <label className="avs-switch"><button type="button" aria-pressed={checked} onClick={() => onCheckedChange(!checked)}><span /></button>{label ? <span>{label}</span> : null}</label>
}
