import rehypeKatex from "rehype-katex"
import remarkGfm from "remark-gfm"
import remarkMath from "remark-math"

// Keep raw Markdown/LaTeX in storage and exports; this translation is display-only.
// remark-math understands dollar delimiters, while agent output also commonly uses
// TeX's \(...\) and \[...\] delimiters.
export function markdownForMathDisplay(source) {
  const lines = source.split("\n")
  const output = []
  let fence = null
  let inlineTicks = 0
  let displayMath = false
  const nextDisplayClose = new Array(lines.length)
  let nextClose = -1
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (/^\s*\\\]\s*$/.test(lines[index])) nextClose = index
    nextDisplayClose[index] = nextClose
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1]
    if (fence) {
      output.push(line)
      if (marker && marker[0] === fence[0] && marker.length >= fence.length &&
          line.slice(line.indexOf(marker) + marker.length).trim() === "") fence = null
      continue
    }
    if (marker) {
      fence = marker
      output.push(line)
      continue
    }
    if (/^(?: {4}|\t)/.test(line)) {
      output.push(line)
      continue
    }
    if (displayMath) {
      if (/^\s*\\\]\s*$/.test(line)) {
        output.push("$$")
        displayMath = false
      } else {
        output.push(line)
      }
      continue
    }

    // Display math must be a block. Keep unmatched delimiters literal.
    if (/^\s*\\\[\s*$/.test(line)) {
      if (nextDisplayClose[index] > index) {
        output.push("$$")
        displayMath = true
        continue
      }
    }
    const oneLineDisplay = /^\s*\\\[(.+)\\\]\s*$/.exec(line)
    if (oneLineDisplay) {
      output.push("$$", oneLineDisplay[1], "$$")
      continue
    }

    let converted = ""
    for (let cursor = 0; cursor < line.length;) {
      if (line[cursor] === "`") {
        let end = cursor + 1
        while (line[end] === "`") end += 1
        const length = end - cursor
        inlineTicks = inlineTicks === length ? 0 : inlineTicks || length
        converted += line.slice(cursor, end)
        cursor = end
        continue
      }
      if (!inlineTicks && line.slice(cursor, cursor + 2) === "\\(") {
        let precedingSlashes = 0
        for (let position = cursor - 1; line[position] === "\\"; position -= 1) precedingSlashes += 1
        const closing = line.indexOf("\\)", cursor + 2)
        if (precedingSlashes % 2 === 0 && closing !== -1 && closing > cursor + 2) {
          converted += `$${line.slice(cursor + 2, closing)}$`
          cursor = closing + 2
          continue
        }
      }
      converted += line[cursor]
      cursor += 1
    }
    output.push(converted)
  }

  return output.join("\n")
}

export const markdownRemarkPlugins = [remarkGfm, remarkMath]
/** @type {NonNullable<import('react-markdown').Options['rehypePlugins']>} */
export const markdownRehypePlugins = [[rehypeKatex, {
  trust: false,
  throwOnError: true,
  maxExpand: 1000,
}]]
