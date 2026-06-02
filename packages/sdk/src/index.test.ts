import { describe, expect, it } from "vitest"
import {
  areaAnnotation,
  captureScreenshotRegion,
  classifyAreaSelection,
  collectElementsInArea,
  formatShowEventMessage,
  humanAnnotationEvent,
  screenshotPointFromViewport,
  screenshotRectFromViewport,
  screenshotAnnotation,
  type ShowAnchor
} from "./index.js"

describe("show annotation event contract", () => {
  it("preserves both user region and matched elements for element-group annotations", () => {
    const matchedElements: ShowAnchor[] = [
      { kind: "element", selector: "[mark-default='card.a']", label: "Card A" },
      { kind: "element", selector: "[mark-default='card.b']", label: "Card B" }
    ]
    const annotation = areaAnnotation({
      id: "ann_area",
      scope: "review",
      intent: "change",
      comment: "These two cards should be compared as one group.",
      userRegion: { x: 10, y: 20, width: 300, height: 140 },
      matchedElements,
      classification: {
        confidence: 0.86,
        reason: "selection tightly covers two card elements",
        ambiguous: false
      }
    })
    const event = humanAnnotationEvent("human.annotation.created", annotation, undefined, "ses_123", "evt_123", undefined, "2026-06-03T00:00:00.000Z")

    expect(event.annotation.primaryAnchor).toBe("element-group")
    expect(event.annotation.userRegion).toEqual({ x: 10, y: 20, width: 300, height: 140 })
    expect(event.annotation.matchedElements).toHaveLength(2)
    expect(formatShowEventMessage(event)).toContain("[show-annotation:review:created] change")
    expect(formatShowEventMessage(event)).toContain("Anchor kind: element-group")
    expect(formatShowEventMessage(event)).toContain("Matched elements: 2")
  })

  it("classifies multi-element area selections as element groups", () => {
    const matchedElements: ShowAnchor[] = [
      { kind: "element", selector: "[data-card='a']", rect: { x: 12, y: 24, width: 80, height: 40 } },
      { kind: "element", selector: "[data-card='b']", rect: { x: 120, y: 24, width: 80, height: 40 } }
    ]

    const classification = classifyAreaSelection({ x: 10, y: 20, width: 220, height: 80 }, matchedElements)

    expect(classification.reason).toBe("selection contains multiple meaningful elements")
    expect(classification.ambiguous).toBe(true)
  })

  it("collects area elements only inside the caller-provided root", () => {
    const previousElement = globalThis.Element
    const previousHTMLElement = globalThis.HTMLElement
    const previousDocument = globalThis.Document
    const previousDocumentGlobal = globalThis.document
    const previousNode = globalThis.Node
    const root = new FakeElement("div", "Root", { x: 0, y: 0, width: 220, height: 120 })
    const inside = new FakeElement("button", "Inside", { x: 20, y: 20, width: 80, height: 40 })
    const outside = new FakeElement("button", "Outside", { x: 30, y: 30, width: 80, height: 40 })
    root.append(inside)
    const fakeDocument = {
      body: new FakeElement("body", "", { x: 0, y: 0, width: 1000, height: 800 })
    }
    fakeDocument.body.append(root, outside)

    try {
      Object.assign(globalThis, {
        Element: FakeElement,
        HTMLElement: FakeElement,
        Node: { ELEMENT_NODE: 1 },
        Document: FakeDocument,
        document: fakeDocument
      })
      const anchors = collectElementsInArea({ x: 0, y: 0, width: 180, height: 100 }, { root, maxElements: 4 })

      expect(anchors).toHaveLength(1)
      expect(anchors[0].label).toBe("Inside")
    } finally {
      Object.assign(globalThis, {
        Element: previousElement,
        HTMLElement: previousHTMLElement,
        Document: previousDocument,
        Node: previousNode,
        document: previousDocumentGlobal
      })
    }
  })

  it("converts screenshot comment geometry into screenshot-local coordinates", () => {
    const capturedRegion = { x: 100, y: 200, width: 640, height: 360 }

    expect(screenshotPointFromViewport({ x: 140, y: 260 }, capturedRegion)).toEqual({ x: 40, y: 60 })
    expect(screenshotRectFromViewport({ x: 120, y: 230, width: 80, height: 40 }, capturedRegion)).toEqual({
      x: 20,
      y: 30,
      width: 80,
      height: 40
    })
  })

  it("does not fake screenshot pixels when display capture is unavailable", async () => {
    const capture = await captureScreenshotRegion({ x: 10, y: 20, width: 160, height: 90 })

    expect(capture.captured).toBe(false)
    expect(capture.dataUrl).toBeUndefined()
    expect(capture.captureError).toMatch(/Display capture|browser document|Screenshot capture/)
  })

  it("formats one screenshot with multiple numbered comments as a single annotation", () => {
    const annotation = screenshotAnnotation({
      id: "ann_shot",
      scope: "review",
      intent: "question",
      screenshot: {
        attachmentId: "att_123",
        mimeType: "image/png",
        width: 960,
        height: 540,
        capturedRegion: { x: 100, y: 120, width: 960, height: 540 },
        viewport: { width: 1440, height: 900, scrollX: 0, scrollY: 240 },
        items: [
          { label: 1, comment: "The chart and the conclusion disagree.", point: { x: 220, y: 180 } },
          { label: 2, comment: "This empty area looks accidental.", rect: { x: 620, y: 320, width: 180, height: 90 } }
        ]
      }
    })
    const event = humanAnnotationEvent("human.annotation.created", annotation, undefined, "ses_123", "evt_456", undefined, "2026-06-03T00:00:00.000Z")
    const message = formatShowEventMessage(event)

    expect(event.annotation.primaryAnchor).toBe("screenshot")
    expect(event.annotation.screenshot?.items).toHaveLength(2)
    expect(message).toContain("[show-annotation:review:created] question")
    expect(message).toContain("Anchor kind: screenshot")
    expect(message).toContain("Screenshot: att_123")
    expect(message).toContain("1. The chart and the conclusion disagree.")
    expect(message).toContain("2. This empty area looks accidental.")
  })
})

class FakeDocument {}

class FakeElement {
  attributes: { name: string; value: string }[] = []
  children: FakeElement[] = []
  className = ""
  id = ""
  nodeType = 1
  ownerDocument?: unknown
  parent?: FakeElement
  parentElement?: FakeElement

  constructor(
    readonly tagName: string,
    readonly textContent: string,
    private rect: { x: number; y: number; width: number; height: number }
  ) {}

  append(...children: FakeElement[]) {
    for (const child of children) {
      child.parent = this
      child.parentElement = this
      child.ownerDocument = this.ownerDocument
      this.children.push(child)
    }
  }

  querySelectorAll() {
    return this.children.flatMap((child) => [child, ...child.querySelectorAll()])
  }

  contains(element: FakeElement) {
    return element === this || this.children.some((child) => child.contains(element))
  }

  closest() {
    return null
  }

  getAttribute() {
    return null
  }

  getBoundingClientRect() {
    return {
      ...this.rect,
      left: this.rect.x,
      top: this.rect.y,
      right: this.rect.x + this.rect.width,
      bottom: this.rect.y + this.rect.height,
      toJSON: () => this.rect
    } as DOMRect
  }
}
