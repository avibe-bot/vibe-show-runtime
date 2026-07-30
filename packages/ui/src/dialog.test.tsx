import * as React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { Dialog, DialogContent, DialogTrigger } from "./dialog"

describe("Dialog", () => {
  it("captures its source scope without inserting a marker element", () => {
    const markup = renderToStaticMarkup(
      <ul>
        <Dialog>
          <DialogTrigger asChild><li>Open</li></DialogTrigger>
          <DialogContent>Content</DialogContent>
        </Dialog>
      </ul>
    )
    expect(markup).toMatch(/^<ul><li[^>]*>Open<\/li><\/ul>$/)
    expect(markup).not.toContain("<span")
  })
})
