import { describe, expect, it, vi } from "vitest"
import {
  DEFAULT_ANNOTATION_LABELS,
  disabledButtonStyle,
  mergeAnnotationLabels,
  modePillLabel,
  tooltipPlacement,
  edgeHandleAnchor,
  edgeHandleVisual,
  createChromeFocusController,
  TOUCH_CAPABLE_QUERY
} from "./react.js"
import {
  fabHideOptions,
  formatFabShortcut,
  formatMarkParam,
  withParenthetical,
  type FabParamUrl
} from "./annotation-control.js"

/**
 * The row label the '?' popup renders for one hide target — the same composition AnnotationChrome does,
 * against `search` as the URL stands when the popup is opened (ToolbarHelp snapshots it there).
 */
function hideRowLabel(target: "handle" | "hidden", shortcut: string | undefined, url: FabParamUrl = {}): string {
  const L = DEFAULT_ANNOTATION_LABELS
  if (target === "handle") return withParenthetical(L.hideToHandleAction, L.hideToHandleHint)
  return shortcut
    ? withParenthetical(L.hideAction, L.hideActionHint(shortcut))
    : withParenthetical(L.hideCompletelyAction, L.hideCompletelyHint(formatMarkParam(url)))
}

// Recovery hints live in the PARENTHESES of the button that hides, named ONCE. Before Lane U the tip and
// the toast each recited the shortcut AND the handle, so a desktop user was told about a grabber they never
// get and read '⌥M' three times. These assertions lock the final user-visible strings — composed through the
// same helpers the component uses, so drift in either the base or the clause fails here.
describe("hide copy names each recovery exactly once, in the row that performs it (Lane U)", () => {
  it("fabTip describes what annotation DOES — no shortcut, no handle, no query-param jargon", () => {
    const tip = DEFAULT_ANNOTATION_LABELS.fabTip
    for (const leaked of ["把手", "Alt+M", "Option+M", "⌥M", "?mark", "?unmark"]) {
      expect(tip).not.toContain(leaked)
    }
    expect(tip).toBe("点选元素或截图，把意见直接发给 Agent")
  })

  it("desktop gets ONE destructive row naming the platform shortcut — and no handle option", () => {
    const options = fabHideOptions(false)
    expect(options).toEqual(["hidden"]) // desktop cannot CREATE a handle state

    expect(hideRowLabel("hidden", formatFabShortcut({ platform: "macOS" }))).toBe("隐藏标注按钮（Option+M 恢复）")
    expect(hideRowLabel("hidden", formatFabShortcut({ platform: "Windows" }))).toBe("隐藏标注按钮（Alt+M 恢复）")
  })

  it("touch gets TWO rows, handle first, neither mentioning a keyboard it does not have", () => {
    const options = fabHideOptions(true)
    expect(options).toEqual(["handle", "hidden"]) // order is the rendered order

    const shortcut = formatFabShortcut({ platform: "iPhone", touchPrimary: true }) // undefined
    const rows = options.map((target) => hideRowLabel(target, shortcut))
    expect(rows).toEqual(["隐藏至把手（点把手可恢复）", "完全隐藏（网址加 ?mark 恢复）"])
    for (const row of rows) {
      expect(row).not.toContain("Alt+M")
      expect(row).not.toContain("Option+M")
    }
  })

  // A literal "?mark" appended to a page that already has a query string yields `?foo=1?mark`, which
  // URLSearchParams reads as a single `foo` value — no `mark` key, so the stored `hidden` survives the reload.
  // Full-hide is the one state with neither a handle nor a shortcut, so the hint has to be copy-pasteable on
  // the URL actually in front of the reader, not merely correct on a clean one.
  it("the full-hide hint adapts its separator to the URL the reader is on", () => {
    const L = DEFAULT_ANNOTATION_LABELS
    // Clean URL → the friendly literal.
    expect(hideRowLabel("hidden", undefined, {})).toBe("完全隐藏（网址加 ?mark 恢复）")
    expect(L.hiddenToast(formatMarkParam({}))).toBe("已完全隐藏，网址加 ?mark 可恢复")
    // Query string already present → "&mark", in BOTH the row and its toast.
    expect(hideRowLabel("hidden", undefined, { search: "?foo=1" })).toBe("完全隐藏（网址加 &mark 恢复）")
    expect(L.hiddenToast(formatMarkParam({ search: "?vibe-embed=1&debug" }))).toBe("已完全隐藏，网址加 &mark 可恢复")
    // The premise, pinned so nobody "simplifies" this back to a hardcoded literal.
    expect(new URLSearchParams("?foo=1?mark").has("mark")).toBe(false)
    expect(new URLSearchParams("?foo=1&mark").has("mark")).toBe(true)
  })

  // The copy is unchanged; what changed is where the separator is measured. On a hash-routed page the reader
  // appends past the search, into the hash — so the row must describe THAT segment, or it prints a token that
  // lands where nothing reads it.
  it("on a hash route the hint describes the HASH's tail, not the search's", () => {
    // Search has a query, hash has none: the append lands in the hash → the clean literal is the correct one.
    expect(hideRowLabel("hidden", undefined, { search: "?foo=1", hash: "#/route" })).toBe(
      "完全隐藏（网址加 ?mark 恢复）"
    )
    // The hash already carries its own query → "&mark", regardless of the search.
    expect(hideRowLabel("hidden", undefined, { hash: "#/route?a=1" })).toBe("完全隐藏（网址加 &mark 恢复）")
  })

  it("each toast repeats the hint for the state just entered, and nothing else", () => {
    const L = DEFAULT_ANNOTATION_LABELS
    expect(L.hiddenShortcutToast("Option+M")).toBe("已隐藏，按 Option+M 恢复")
    expect(L.hiddenShortcutToast("Alt+M")).toBe("已隐藏，按 Alt+M 恢复")
    expect(L.handleToast).toBe("已缩至边缘把手，轻点可恢复")
    expect(L.hiddenToast("?mark")).toBe("已完全隐藏，网址加 ?mark 可恢复")

    // The handle toast is the touch path; it must not advertise a shortcut, and the desktop toast must not
    // advertise a grabber the desktop never renders.
    expect(L.handleToast).not.toContain("+M")
    expect(L.hiddenShortcutToast("Option+M")).not.toContain("把手")
  })

  it("labels stay ADDITIVE, so overriding one string cannot cost a host the platform behavior", () => {
    // A host renaming the base action keeps the auto-detected parenthetical clause.
    const copy = mergeAnnotationLabels({ hideAction: "Hide", hideCompletelyAction: "Hide for good" })
    expect(withParenthetical(copy.hideAction, copy.hideActionHint("Alt+M"))).toBe("Hide（Alt+M 恢复）")
    // Same for the URL clause: renaming the row keeps the separator the current URL earned.
    expect(withParenthetical(copy.hideCompletelyAction, copy.hideCompletelyHint(formatMarkParam({ search: "?foo=1" })))).toBe(
      "Hide for good（网址加 &mark 恢复）"
    )
    expect(copy.handleToast).toBe(DEFAULT_ANNOTATION_LABELS.handleToast) // untouched fields keep defaults
  })

  it("mergeAnnotationLabels fills EVERY field, so a newly added label can never render blank", () => {
    const copy = mergeAnnotationLabels(undefined)
    for (const key of Object.keys(DEFAULT_ANNOTATION_LABELS)) {
      expect(copy[key as keyof typeof copy], key).toBeDefined()
    }
    // An explicitly-undefined override is an absent override, not a blank string.
    expect(mergeAnnotationLabels({ hideAction: undefined }).hideAction).toBe(DEFAULT_ANNOTATION_LABELS.hideAction)
    // exitShort still falls back through `exit` before the default.
    expect(mergeAnnotationLabels({ exit: "Done" }).exitShort).toBe("Done")
  })

  it("the '?' trigger has a fallback accessible name for when a host suppresses the tip copy", () => {
    // With an empty fabTip the trigger's aria-label falls back to this so a screen reader never reads bare '?'.
    expect(DEFAULT_ANNOTATION_LABELS.helpTrigger).toBe("帮助")
  })
})

// The handle is the only chrome a user can hide INTO and tap back out of, so a user-initiated collapse pulses
// once (~1.5s) to show where it went. Rest/hover geometry is browser-verified; this locks the three visual
// states so a refactor can't make the pulse indistinguishable from rest.
describe("edgeHandleVisual: the collapse target announces itself once, then recedes (Lane U)", () => {
  it("pulses widest + fully opaque, outranking hover, and settles to a faint resting sliver", () => {
    const pulsing = edgeHandleVisual({ pulsing: true })
    const active = edgeHandleVisual({ active: true })
    const rest = edgeHandleVisual({})

    expect(pulsing).toEqual({ width: 9, opacity: 1 })
    expect(active).toEqual({ width: 7, opacity: 0.55 })
    expect(rest).toEqual({ width: 5, opacity: 0.2 })

    expect(pulsing.width).toBeGreaterThan(active.width)
    expect(active.width).toBeGreaterThan(rest.width)
    expect(pulsing.opacity).toBeGreaterThan(active.opacity)
    expect(active.opacity).toBeGreaterThan(rest.opacity)
  })

  it("pulse wins even while hovered, so the attention cue is never swallowed by a resting pointer", () => {
    expect(edgeHandleVisual({ active: true, pulsing: true })).toEqual({ width: 9, opacity: 1 })
  })
})

// The edge-handle hit box is sized by touch CAPABILITY, not the primary-pointer flag that drives
// keyboard/layout behavior — otherwise a mouse-primary hybrid (laptop + touchscreen) keeps a 5px target it
// can still finger-tap. Lock the media-query choice in CI so a refactor can't quietly revert to `pointer:`.
describe("touch-capability query sizes the recovery handle hit box (Lane R13)", () => {
  it("keys on any-pointer (device HAS a coarse pointer), not the primary hover/pointer signal", () => {
    expect(TOUCH_CAPABLE_QUERY).toContain("any-pointer: coarse")
    expect(TOUCH_CAPABLE_QUERY).not.toContain("hover") // must NOT be the primary-pointer layout query
  })
})

// One focus-succession mechanism covers BOTH chrome swaps (hide→handle, restore→FAB): the successor control
// claims focus on mount so a keyboard user is never dropped on <body>. The DOM wiring is browser-verified;
// this locks the pure state machine — armed once, consumed once, never fires unarmed (e.g. initial load).
describe("createChromeFocusController: focus follows the control that replaces the one in use (Lane R13)", () => {
  it("focuses the next mounted control exactly once after a request, then disarms", () => {
    const c = createChromeFocusController()
    const first = { focus: vi.fn() }
    const second = { focus: vi.fn() }
    c.request()
    c.claim(first)
    expect(first.focus).toHaveBeenCalledTimes(1)
    // A second mount without a new request (e.g. a re-render) must not steal focus back.
    c.claim(second)
    expect(second.focus).not.toHaveBeenCalled()
  })

  it("never focuses without a request — so a stored-hidden FAB can't autofocus its handle on page load", () => {
    const c = createChromeFocusController()
    const node = { focus: vi.fn() }
    c.claim(node)
    expect(node.focus).not.toHaveBeenCalled()
  })

  // Why hideFab arms ONLY for the `handle` target: a request stays pending until *something* mounts, so
  // arming with no successor (the fully hidden state renders nothing) leaves it live indefinitely, and the
  // next unrelated mount consumes it — an SPA swapping sessionId would steal focus, and because claim()'s
  // return value is also the pulse signal, a handle would announce itself for an action the user never took.
  it("an unconsumed request survives to be claimed by an unrelated LATER mount — hence: don't arm without a successor", () => {
    const c = createChromeFocusController()
    const unrelated = { focus: vi.fn() }
    c.request() // armed, but nothing mounts to consume it
    expect(c.claim(unrelated)).toBe(true) // ...so a much later, unrelated mount takes it
    expect(unrelated.focus).toHaveBeenCalledTimes(1)
  })

  it("claim() reports whether it consumed a request — the 'user-initiated' signal the handle pulse rides", () => {
    const c = createChromeFocusController()
    const node = { focus: vi.fn() }
    expect(c.claim(node)).toBe(false) // page load: no request, no pulse
    c.request()
    expect(c.claim(node)).toBe(true) // user-initiated swap: pulse
    expect(c.claim(node)).toBe(false) // consumed once only
    expect(c.claim(null)).toBe(false) // a detaching node never counts as user-initiated
  })

  it("a null node (the outgoing control unmounting) is a no-op and keeps the request armed for the successor", () => {
    const c = createChromeFocusController()
    const successor = { focus: vi.fn() }
    c.request()
    c.claim(null) // outgoing control detaches first
    c.claim(successor) // incoming control mounts
    expect(successor.focus).toHaveBeenCalledTimes(1)
  })

  it("re-arms for each swap: a fresh request focuses the next control again", () => {
    const c = createChromeFocusController()
    const a = { focus: vi.fn() }
    const b = { focus: vi.fn() }
    c.request()
    c.claim(a)
    c.request()
    c.claim(b)
    expect(a.focus).toHaveBeenCalledTimes(1)
    expect(b.focus).toHaveBeenCalledTimes(1)
  })
})

describe("edgeHandleAnchor: places the hidden-FAB recovery grabber at the last snapped edge (Lane R13)", () => {
  it("pins to a stored placement's edge + vertical offset, inner corners rounded", () => {
    expect(edgeHandleAnchor({ edge: "left", top: 120 })).toEqual({ left: 0, borderRadius: "0 8px 8px 0", top: 120 })
    expect(edgeHandleAnchor({ edge: "right", top: 240 })).toEqual({ right: 0, borderRadius: "8px 0 0 8px", top: 240 })
  })

  it("defaults to the right edge, vertically centered, when the FAB was never dragged", () => {
    for (const p of [null, undefined]) {
      expect(edgeHandleAnchor(p)).toEqual({ right: 0, borderRadius: "8px 0 0 8px", top: "calc(50% - 24px)" })
    }
  })

  it("clamps a stored top into the current viewport so the handle never strands off-screen (P1)", () => {
    // top 700 saved in a taller window, opened at 640px → clamp to 640 - 48 - 12 = 580
    expect(edgeHandleAnchor({ edge: "right", top: 700 }, 640).top).toBe(580)
    expect(edgeHandleAnchor({ edge: "left", top: -50 }, 640).top).toBe(12) // negative clamps up to the margin
    expect(edgeHandleAnchor({ edge: "right", top: 200 }, 640).top).toBe(200) // within range → unchanged
    expect(edgeHandleAnchor({ edge: "right", top: 700 }).top).toBe(700) // no viewport known → raw top
  })
})

describe("'?' tooltip placement stays within the viewport (Lane R12 round 2/3)", () => {
  const vp = { width: 320, height: 640 }
  const margin = 12

  it("opens leftward and stays on-screen when the ? button is near the right edge", () => {
    // Default right-docked toolbar at 320px: ? button ~[229,257] with the ✕ + padding to its right.
    const p = tooltipPlacement({ left: 229, right: 257, top: 560, bottom: 588 }, vp)
    expect(p.position).toBe("fixed")
    expect(p).toHaveProperty("right")
    const width = p.maxWidth as number
    const leftEdge = vp.width - (p.right as number) - width // left edge of the tip (border-box, incl. padding)
    expect(leftEdge).toBeGreaterThanOrEqual(margin - 1) // clamped on-screen (allow rounding)
    expect(width).toBeGreaterThan(60) // no longer the 2–4-char vertical strip
  })

  it("opens rightward and stays on-screen when the ? button is near the left edge", () => {
    const p = tooltipPlacement({ left: 8, right: 36, top: 560, bottom: 588 }, vp)
    expect(p).toHaveProperty("left")
    expect(p.left as number).toBeGreaterThanOrEqual(margin)
    expect((p.left as number) + (p.maxWidth as number)).toBeLessThanOrEqual(vp.width - margin + 1)
  })

  it("opens ABOVE with room, capping at the preferred max width on a wide desktop viewport", () => {
    const p = tooltipPlacement({ left: 900, right: 928, top: 400, bottom: 428 }, { width: 1440, height: 900 })
    expect(p.maxWidth).toBe(280)
    expect(p.bottom).toBe(900 - 400 + 10) // bottom edge 10px above the button top
    expect(p).not.toHaveProperty("top")
    expect(p.maxHeight).toBe(400 - 10 - 12) // capped to the room above so a tall popup can't overflow the top
  })

  it("flips BELOW the button when the toolbar is top-docked (no room above)", () => {
    // button.top ~30 leaves < estimatedHeight above → must open below, not clip off the top
    const p = tooltipPlacement({ left: 260, right: 288, top: 30, bottom: 58 }, vp)
    expect(p.top).toBe(58 + 10)
    expect(p).not.toHaveProperty("bottom")
    expect(p.maxHeight).toBe(640 - 58 - 10 - 12) // capped to the room below (finding 6)
  })

  it("picks the side with MORE room when neither has the estimated height (short viewport)", () => {
    // 200px viewport, button [90,118]: spaceAbove 78 > spaceBelow 70, both < 120 → open ABOVE (the roomier side)
    const above = tooltipPlacement({ left: 100, right: 128, top: 90, bottom: 118 }, { width: 320, height: 200 })
    expect(above).toHaveProperty("bottom")
    expect(above).not.toHaveProperty("top")
    // 130px viewport, button [30,58]: spaceAbove 18 < spaceBelow 60, both < 120 → open BELOW (the roomier side)
    const below = tooltipPlacement({ left: 100, right: 128, top: 30, bottom: 58 }, { width: 320, height: 130 })
    expect(below).toHaveProperty("top")
    expect(below).not.toHaveProperty("bottom")
  })
})

// Overlay uses inline styles (no `:disabled` stylesheet), so the disabled LOOK is applied explicitly.
// These pure assertions run in CI (the browser layout check does not), locking the visual contract the
// owner flagged: a disabled send must read dimmed/gray, never the bright mint of an enabled action.
describe("screenshot comment card polish (Lane R8)", () => {
  const primary = { color: "#080812", background: "#5BFFA0", boxShadow: "0 8px 24px x", cursor: "pointer" }

  it("disabledButtonStyle dims to gray + not-allowed and drops the shadow when disabled", () => {
    const off = disabledButtonStyle(primary, true)
    expect(off.background).toBe("rgba(255, 255, 255, 0.05)") // surfaceRaised gray, NOT mint #5BFFA0
    expect(off.color).toBe("rgba(245, 246, 250, 0.58)") // textMuted
    expect(off.cursor).toBe("not-allowed")
    expect(off.boxShadow).toBe("none")
    expect(off.background).not.toBe(primary.background) // definitely not the enabled mint
  })

  it("disabledButtonStyle is a same-ref no-op when enabled (keeps the mint primary)", () => {
    expect(disabledButtonStyle(primary, false)).toBe(primary)
  })

  it("send label reads '发送评论' at 0 comments and '发送 N 条评论' once there is at least one", () => {
    expect(DEFAULT_ANNOTATION_LABELS.sendBatch(0)).toBe("发送评论") // avoids the odd '发送 0 条评论'
    expect(DEFAULT_ANNOTATION_LABELS.sendBatch(1)).toBe("发送 1 条评论")
    expect(DEFAULT_ANNOTATION_LABELS.sendBatch(3)).toBe("发送 3 条评论")
  })
})

// The embedded mode pill wrapped to two lines on an iPhone. The layout fix (nowrap + fit-content) is
// browser-verified; here we lock the COPY choice: touch drops the '标注模式 · ' prefix / long hint so the
// pill stays one line at 320px, while desktop keeps the full label.
describe("mobile mode-pill label (Lane R9)", () => {
  const L = DEFAULT_ANNOTATION_LABELS

  it("desktop keeps the full smart label; touch shows just the mode name", () => {
    expect(modePillLabel("smart", false, L)).toBe("标注模式 · Smart")
    expect(modePillLabel("smart", true, L)).toBe("Smart") // '标注模式 · ' prefix dropped on coarse pointer
  })

  it("desktop shows the screenshot hint; touch shortens to just '截图'", () => {
    expect(modePillLabel("screenshot", false, L)).toBe("拖拽框选截图区域")
    expect(modePillLabel("screenshot", true, L)).toBe("截图")
  })

  it("the touch labels are short enough to stay one line (no ' · ' prefix)", () => {
    expect(modePillLabel("smart", true, L)).not.toContain("·")
    expect(modePillLabel("screenshot", true, L)).not.toContain("·")
  })
})
