function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {}
}

function list(value) {
  return Array.isArray(value) ? value : []
}

function text(value, fallback = "") {
  return typeof value === "string" || typeof value === "number" ? String(value) : fallback
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function humanizeKey(value) {
  return String(value)
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim()
    .replace(/^./, (character) => character.toUpperCase())
}

/**
 * Format a bounded table value as scholarly display text without exposing the
 * serialized storage shape. This deliberately does not parse or execute rich
 * content; it only projects the already validated surface value.
 */
export function formatSurfaceCell(value, depth = 0) {
  if (value === null || value === undefined || value === "") return "—"
  if (typeof value === "boolean") return value ? "Yes" : "No"
  if (typeof value === "string" || typeof value === "number") return String(value)
  if (depth >= 2) return "Structured value"
  if (Array.isArray(value)) {
    if (value.length === 0) return "—"
    const visible = value.slice(0, 8).map((item) => formatSurfaceCell(item, depth + 1))
    if (value.length > visible.length) visible.push(`+${value.length - visible.length} more`)
    return visible.join(" · ")
  }
  if (typeof value !== "object") return "—"

  const entries = Object.entries(value).slice(0, 8)
  if (entries.length === 0) return "—"
  const preferred = ["label", "title", "name", "value", "text", "id"]
    .find((key) => Object.hasOwn(value, key))
  if (preferred && entries.length === 1) return formatSurfaceCell(value[preferred], depth + 1)
  const visible = entries.map(([key, item]) =>
    `${humanizeKey(key)}: ${formatSurfaceCell(item, depth + 1)}`,
  )
  if (Object.keys(value).length > visible.length) visible.push(`+${Object.keys(value).length - visible.length} fields`)
  return visible.join(" · ")
}

const STRUCTURAL_CHART_VARIANTS = new Set([
  "sankeyNodes", "chordNodes", "graphNodes", "vennSets", "vennIntersections",
])

function chartPoint(candidate, index, variant, chartType) {
  if (finiteNumber(candidate) !== null) {
    return { x: String(index + 1), y: candidate, label: "" }
  }
  if (typeof candidate === "string") {
    return { x: candidate, y: 1, label: "" }
  }
  if (Array.isArray(candidate)) {
    const y = candidate.map(finiteNumber).find((value) => value !== null)
    return y === undefined
      ? { x: String(index + 1), y: 1, label: text(candidate[0]) }
      : { x: text(candidate[0], String(index + 1)), y, label: "" }
  }
  const item = record(candidate)
  const valueKeys = chartType === "candlestick"
    ? ["close", "value", "y", "high", "open", "low"]
    : chartType === "heatmap"
      ? ["value", "count", "weight", "y"]
      : ["y", "value", "count", "weight", "size", "frequency", "close", "max", "end"]
  const y = valueKeys.map((key) => finiteNumber(item[key])).find((value) => value !== null)
  const relation = typeof item.from === "string" && typeof item.to === "string"
    ? `${item.from} → ${item.to}`
    : ""
  const sets = Array.isArray(item.sets) ? item.sets.map(text).filter(Boolean).join(" ∩ ") : ""
  const x = text(
    item.x ?? item.label ?? item.name ?? item.text ?? item.word ?? item.id ?? item.key ?? item.stage ?? item.date,
    relation || sets || String(index + 1),
  )
  const label = text(item.label ?? item.name ?? item.text ?? item.word ?? item.id)
  // Structural variants such as graph or Venn nodes can legitimately carry no
  // scalar; represent each bounded item as one visible datum instead of hiding it.
  const structuralLabel = STRUCTURAL_CHART_VARIANTS.has(variant) ? variant : ""
  return { x, y: y ?? 1, label: label === x ? "" : label || structuralLabel }
}

function variantSeries(data, field, chartType) {
  const values = list(data[field])
  if (values.length === 0) return []
  const points = field === "treeMapData"
    ? values.flatMap((value) => hierarchyPoints(value))
    : values.map((candidate, index) => chartPoint(candidate, index, field, chartType))
  return [{
    name: text(field.replace(/([A-Z])/g, " $1").toLowerCase(), "data"),
    points,
  }]
}

function hierarchyPoints(value, path = [], depth = 0) {
  if (depth > 12) return []
  const node = record(value)
  const label = text(node.label ?? node.name ?? node.id, `Level ${depth + 1}`)
  const children = list(node.children)
  if (children.length > 0) {
    return children.flatMap((child) => hierarchyPoints(child, [...path, label], depth + 1))
  }
  const point = chartPoint(node, 0, "hierarchy", "hierarchy")
  return [{ ...point, x: [...path, label].filter(Boolean).join(" / ") }]
}

function timelineDate(value) {
  const date = record(value)
  if (typeof date.display_date === "string" && date.display_date.trim()) return date.display_date.trim()
  if (!Number.isInteger(date.year)) return ""
  const month = Number.isInteger(date.month) ? `-${String(date.month).padStart(2, "0")}` : ""
  const day = Number.isInteger(date.day) ? `-${String(date.day).padStart(2, "0")}` : ""
  return `${date.year}${month}${day}`
}

export function projectChartData(props) {
  const data = record(record(props).data)
  const chartType = text(data.type)
  const series = list(data.series).flatMap((candidate, seriesIndex) => {
    const item = record(candidate)
    const points = list(item.data).map((point, index) => chartPoint(point, index, "series", chartType))
    if (points.length === 0) return []
    return [{ name: text(item.name, `Series ${seriesIndex + 1}`), points }]
  })
  for (const field of [
    "data", "stages", "sankeyNodes", "sankeyLinks", "chordNodes", "chordLinks",
    "treeMapData", "graphNodes", "graphLinks", "words", "vennSets", "vennIntersections", "ranges",
  ]) {
    series.push(...variantSeries(data, field, chartType))
  }
  if (finiteNumber(data.value) !== null) {
    series.push({
      name: text(data.title, chartType || "value"),
      points: [{ x: chartType || "value", y: data.value, label: "" }],
    })
  }
  if (Object.hasOwn(data, "hierarchyData")) {
    series.push({ name: "hierarchy data", points: hierarchyPoints(data.hierarchyData) })
  }
  return { title: text(data.title, series[0]?.name || chartType || "Chart"), series }
}

export function projectTimelineData(props) {
  const data = record(record(props).data)
  return list(data.events).map((candidate, index) => {
    const event = record(candidate)
    const content = record(event.text)
    return {
      id: text(event.unique_id, String(index)),
      title: text(content.headline, `Event ${index + 1}`),
      date: text(event.display_date) || timelineDate(event.start_date),
      description: text(content.text),
    }
  })
}

export function projectKnowledgeGraphData(props) {
  const data = record(record(props).data)
  const entities = list(data.entities).map((candidate, index) => {
    const entity = record(candidate)
    return {
      id: text(entity.id, String(index)),
      label: text(entity.label, `Entity ${index + 1}`),
      type: text(entity.type),
    }
  })
  const relationships = list(data.relationships).map((candidate, index) => {
    const relationship = record(candidate)
    return {
      id: text(relationship.id, String(index)),
      source: text(relationship.source),
      target: text(relationship.target),
      type: text(relationship.label || relationship.type, "related to"),
    }
  })
  return { title: text(record(props).title, "Knowledge graph"), entities, relationships }
}
