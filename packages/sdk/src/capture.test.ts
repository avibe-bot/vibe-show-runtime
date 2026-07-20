import { describe, expect, it, vi } from "vitest"
import {
  captureScreenshotRegion,
  constrainCaptureDimensions,
  defaultCaptureStrategies,
  selectCaptureStrategy,
  SCREENSHOT_MAX_EDGE,
  type CapturedImage,
  type MarkAnchorRect,
  type ScreenshotCaptureStrategy
} from "./index.js"

const REGION: MarkAnchorRect = { x: 20, y: 40, width: 300, height: 180 }

function fakeStrategy(
  name: ScreenshotCaptureStrategy["name"],
  behavior: { available: boolean; result?: CapturedImage; error?: string }
): ScreenshotCaptureStrategy & { calls: number } {
  const strategy = {
    name,
    calls: 0,
    isAvailable: () => behavior.available,
    async capture() {
      strategy.calls += 1
      if (behavior.error) throw new Error(behavior.error)
      return behavior.result ?? { dataUrl: `data:${name}`, width: 300, height: 180 }
    }
  }
  return strategy
}

describe("constrainCaptureDimensions", () => {
  it("leaves within-bound dimensions untouched", () => {
    expect(constrainCaptureDimensions(300, 180)).toEqual({ width: 300, height: 180, scale: 1 })
  })

  it("downscales the long edge to the cap, preserving aspect ratio", () => {
    const result = constrainCaptureDimensions(4096, 2048, SCREENSHOT_MAX_EDGE)
    expect(result.width).toBe(2048)
    expect(result.height).toBe(1024)
    expect(result.scale).toBeCloseTo(0.5)
  })

  it("never returns a zero dimension", () => {
    expect(constrainCaptureDimensions(0, 0).width).toBeGreaterThanOrEqual(1)
  })
})

describe("selectCaptureStrategy", () => {
  it("returns the first available strategy", () => {
    const snap = fakeStrategy("snapdom", { available: false })
    const display = fakeStrategy("display-media", { available: true })
    expect(selectCaptureStrategy([snap, display])).toBe(display)
  })

  it("returns undefined when none are available", () => {
    expect(selectCaptureStrategy([fakeStrategy("snapdom", { available: false })])).toBeUndefined()
  })
})

describe("captureScreenshotRegion strategy selection", () => {
  it("prefers snapDOM and preserves the payload shape", async () => {
    const snap = fakeStrategy("snapdom", { available: true, result: { dataUrl: "data:snap", width: 300, height: 180 } })
    const display = fakeStrategy("display-media", { available: true })
    const result = await captureScreenshotRegion(REGION, { strategies: [snap, display] })

    expect(result.captured).toBe(true)
    expect(result.dataUrl).toBe("data:snap")
    expect(result.mimeType).toBe("image/png")
    expect(result.capturedRegion).toEqual(REGION)
    expect(result.width).toBe(300)
    expect(result.height).toBe(180)
    expect(result.attachmentId).toMatch(/^screenshot_/)
    expect(display.calls).toBe(0)
  })

  it("falls back to display-media when snapDOM is unavailable", async () => {
    const snap = fakeStrategy("snapdom", { available: false })
    const display = fakeStrategy("display-media", { available: true, result: { dataUrl: "data:display", width: 300, height: 180 } })
    const result = await captureScreenshotRegion(REGION, { strategies: [snap, display] })
    expect(result.captured).toBe(true)
    expect(result.dataUrl).toBe("data:display")
    expect(snap.calls).toBe(0)
    expect(display.calls).toBe(1)
  })

  it("falls through to the next strategy when snapDOM throws", async () => {
    const snap = fakeStrategy("snapdom", { available: true, error: "render failed" })
    const display = fakeStrategy("display-media", { available: true, result: { dataUrl: "data:display", width: 10, height: 10 } })
    const result = await captureScreenshotRegion(REGION, { strategies: [snap, display] })
    expect(result.captured).toBe(true)
    expect(result.dataUrl).toBe("data:display")
    expect(snap.calls).toBe(1)
    expect(display.calls).toBe(1)
  })

  it("reports the last error when every strategy fails", async () => {
    const snap = fakeStrategy("snapdom", { available: true, error: "snap boom" })
    const display = fakeStrategy("display-media", { available: true, error: "display boom" })
    const result = await captureScreenshotRegion(REGION, { strategies: [snap, display] })
    expect(result.captured).toBe(false)
    expect(result.captureError).toBe("display boom")
    expect(result.dataUrl).toBeUndefined()
    expect(result.capturedRegion).toEqual(REGION)
  })

  it("reports an unavailable message when no strategy can run (e.g. a non-browser env)", async () => {
    const result = await captureScreenshotRegion(REGION, { strategies: defaultCaptureStrategies() })
    expect(result.captured).toBe(false)
    expect(result.captureError).toBeTruthy()
  })

  it("does not load snapDOM when a screenshot is never captured", async () => {
    const loadSnapdom = vi.fn(async () => ({}))
    // In a non-DOM env the snapDOM strategy is unavailable, so its loader is never invoked.
    await captureScreenshotRegion(REGION, { strategies: defaultCaptureStrategies({ loadSnapdom }) })
    expect(loadSnapdom).not.toHaveBeenCalled()
  })
})
