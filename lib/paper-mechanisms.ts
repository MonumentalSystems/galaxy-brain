export type MechanismSuggestion = {
  id: string
  label: string
  aliases: string[]
}

export const MECHANISM_CATALOG: MechanismSuggestion[] = [
  { id: "vortex", label: "Vortex", aliases: ["vortex", "vortices", "vorticity", "vortex unbinding"] },
  { id: "helicity", label: "Helicity", aliases: ["helicity", "helical", "chirality", "chiral"] },
  { id: "kelvin-helmholtz-instability", label: "Kelvin–Helmholtz instability", aliases: ["kelvin-helmholtz", "kelvin–helmholtz", "shear instability"] },
  { id: "mixing", label: "Mixing", aliases: ["mixing", "turbulent mixing", "plasma mixing"] },
  { id: "defect-dynamics", label: "Defect dynamics", aliases: ["defect", "defects", "defect-bound", "annihilation"] },
  { id: "symmetry-breaking", label: "Symmetry breaking", aliases: ["symmetry breaking", "symmetry-breaking"] },
  { id: "topological-transition", label: "Topological transition", aliases: ["topological", "topology", "bkt", "berezinskii-kosterlitz-thouless"] },
  { id: "floquet-driving", label: "Floquet driving", aliases: ["floquet", "periodic driving", "optical control"] },
  { id: "condensation", label: "Condensation", aliases: ["condensate", "condensation", "exciton condensate"] },
  { id: "polaron-formation", label: "Polaron formation", aliases: ["polaron", "polarons", "dressing"] },
  { id: "crystallization", label: "Crystallization", aliases: ["crystal", "crystallization", "wigner crystal"] },
]

export function mechanismTag(value: string) {
  const slug = value
    .trim()
    .toLocaleLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 68)
  return slug ? `mechanism:${slug}` : ""
}

export function suggestMechanisms(...sources: Array<string | null | undefined>) {
  const haystack = sources.filter(Boolean).join(" ").toLocaleLowerCase()
  return MECHANISM_CATALOG.filter((candidate) =>
    candidate.aliases.some((alias) => haystack.includes(alias.toLocaleLowerCase())),
  ).slice(0, 8)
}

export function mechanismLabel(tag: string) {
  const id = tag.startsWith("mechanism:") ? tag.slice("mechanism:".length) : tag
  return MECHANISM_CATALOG.find((candidate) => candidate.id === id)?.label
    ?? id.replace(/-/g, " ").replace(/^./, (letter) => letter.toLocaleUpperCase())
}

export function mechanismId(value: string) {
  return value.startsWith("mechanism:") ? value.slice("mechanism:".length) : mechanismTag(value).slice("mechanism:".length)
}

export function normalizeMechanismTag(value: string) {
  return mechanismTag(value.startsWith("mechanism:") ? value.slice("mechanism:".length) : value)
}

export function mechanismHref(value: string, basePath = "/papers") {
  return `${basePath}?mechanism=${encodeURIComponent(mechanismId(value))}`
}
