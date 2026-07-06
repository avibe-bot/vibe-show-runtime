export function Switch({
  checked,
  onCheckedChange,
  label
}: {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  label?: string
}) {
  return (
    <label className="inline-flex items-center gap-2 text-[0.8125rem] font-bold text-muted-foreground">
      <button
        type="button"
        aria-pressed={checked}
        onClick={() => onCheckedChange(!checked)}
        className="group h-[1.375rem] w-[2.375rem] cursor-pointer rounded-full border-0 bg-muted-foreground/35 p-0.5 aria-[pressed=true]:bg-primary"
      >
        <span className="block size-[1.125rem] rounded-full bg-white transition-transform group-aria-[pressed=true]:translate-x-4 motion-reduce:transition-none" />
      </button>
      {label ? <span>{label}</span> : null}
    </label>
  )
}
