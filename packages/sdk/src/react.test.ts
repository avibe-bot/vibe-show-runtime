import { describe, expect, it } from "vitest"
import { DEFAULT_ANNOTATION_LABELS, disabledButtonStyle, modePillLabel } from "./react.js"

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
