import assert from "node:assert/strict"
import test from "node:test"

import { isEmbeddedRasterImageSource } from "../lib/markdown-image-policy.js"

test("converter image policy accepts only embedded passive raster data", () => {
  for (const source of [
    "data:image/png;base64,iVBORw==",
    "data:image/jpeg;base64,/9j/4AAQ",
    "data:image/webp;base64,UklGRg==",
  ]) assert.equal(isEmbeddedRasterImageSource(source), true)

  for (const source of [
    "https://tracker.example/diagram.png",
    "data:image/svg+xml;base64,PHN2Zz4=",
    "data:text/html;base64,PHNjcmlwdD4=",
    "data:image/png;base64,",
    "data:image/png;base64,not base64",
  ]) assert.equal(isEmbeddedRasterImageSource(source), false)
})
