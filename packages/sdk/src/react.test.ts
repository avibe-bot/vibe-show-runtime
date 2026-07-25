import { describe, expect, it } from "vitest"
import { DEFAULT_ANNOTATION_LABELS, disabledButtonStyle, modePillLabel, tooltipPlacement, edgeHandleAnchor } from "./react.js"

// Overlay uses inline styles (no `:disabled` stylesheet), so the disabled LOOK is applied explicitly.
// These pure assertions run in CI (the browser layout check does not), locking the visual contract the
// owner flagged: a disabled send must read dimmed/gray, never the bright mint of an enabled action.
describe("FAB copy leads with the edge handle; '?' popup owns the hide action (Lane R12/R13)", () => {
  it("both the tip and the hidden toast name the edge handle + Alt+M, with no query-param jargon", () => {
    for (const copy of [DEFAULT_ANNOTATION_LABELS.fabTip, DEFAULT_ANNOTATION_LABELS.fabHiddenToast]) {
      expect(copy).toContain("把手") // the edge handle is THE cross-platform recovery, mentioned first
      expect(copy).toContain("Alt+M") // desktop shortcut retained
    }
    expect(DEFAULT_ANNOTATION_LABELS.fabTip).toContain("⌥M") // macOS glyph kept in the (longer) tip
    // query params stay the programmatic path but must not be the user-facing copy
    expect(DEFAULT_ANNOTATION_LABELS.fabTip).not.toContain("?unmark")
    expect(DEFAULT_ANNOTATION_LABELS.fabHiddenToast).not.toContain("?mark")
  })

  it("the '?' popup hide row carries a distinct destructive label (no longer a bare ✕)", () => {
    expect(DEFAULT_ANNOTATION_LABELS.hideAction).toBe("隐藏标注按钮")
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
  })

  it("flips BELOW the button when the toolbar is top-docked (no room above)", () => {
    // button.top ~30 leaves < estimatedHeight above → must open below, not clip off the top (finding 4)
    const p = tooltipPlacement({ left: 260, right: 288, top: 30, bottom: 58 }, vp)
    expect(p.top).toBe(58 + 10)
    expect(p).not.toHaveProperty("bottom")
  })
})

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
