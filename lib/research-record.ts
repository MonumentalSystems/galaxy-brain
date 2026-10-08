import type { Experiment } from "@/lib/galaxy-brain-api"
import { buildWandbRunUrl } from "@/lib/eln-experiment-state"

export const RESEARCH_RECORD_SCHEMA_VERSION = "gb.research-record.v1" as const

export type ResearchRecordSectionKey =
  | "hypothesis"
  | "protocol"
  | "configuration"
  | "results"
  | "interpretation"
  | "conclusion"

export interface ResearchRecordSection {
  key: ResearchRecordSectionKey
  title: string
  content: string
}

export interface ResearchRecordResource {
  id: string
  kind: "reference" | "artifact"
  title: string
  href?: string
  mediaType?: string
  excerpt?: string
  ref?: string
  revisionSha256?: string
  contentSha256?: string
  documentRevisionId?: string
}

export interface ResearchRecordMetric {
  id: string
  name: string
  value: number
  step?: number
  source: string
  timestamp: string
}

export interface ResearchRecordDocument {
  schemaVersion: typeof RESEARCH_RECORD_SCHEMA_VERSION
  id: string
  kind: "eln-research-record"
  title: string
  status: Experiment["status"]
  domain: string
  tags: string[]
  sections: ResearchRecordSection[]
  references: ResearchRecordResource[]
  artifacts: ResearchRecordResource[]
  metrics: ResearchRecordMetric[]
  linkedRecordIds: string[]
  provenance: {
    source: "galaxy-brain-eln"
    tenantId: string
    principalId?: string
    hamNodeId?: string
    createdAt: string
    updatedAt: string
  }
}

export type ResearchRecordDraft = Partial<
  Pick<
    Experiment,
    | "title"
    | "status"
    | "domain"
    | "hypothesis"
    | "protocol"
    | "config_snapshot"
    | "results"
    | "interpretation"
    | "conclusion"
    | "tags"
    | "wandb_run_id"
    | "wandb_project"
    | "local_run_path"
    | "linked_experiments"
  >
>

function resourceId(prefix: string, value: string, index: number) {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
  return `${prefix}:${normalized || index}`
}

function asHref(value: string) {
  try {
    const url = new URL(value)
    return url.protocol === "http:" || url.protocol === "https:" ? value : undefined
  } catch {
    return undefined
  }
}

export function experimentToResearchRecord(
  experiment: Experiment,
  draft: ResearchRecordDraft = {},
): ResearchRecordDocument {
  const configSnapshot = draft.config_snapshot ?? experiment.config_snapshot
  const sections: ResearchRecordSection[] = [
    { key: "hypothesis", title: "Hypothesis", content: draft.hypothesis ?? experiment.hypothesis ?? "" },
    { key: "protocol", title: "Protocol", content: draft.protocol ?? experiment.protocol ?? "" },
    {
      key: "configuration",
      title: "Configuration",
      content: configSnapshot && Object.keys(configSnapshot).length > 0
        ? JSON.stringify(configSnapshot, null, 2)
        : "",
    },
    { key: "results", title: "Results", content: draft.results ?? experiment.results ?? "" },
    {
      key: "interpretation",
      title: "Interpretation",
      content: draft.interpretation ?? experiment.interpretation ?? "",
    },
    { key: "conclusion", title: "Conclusion", content: draft.conclusion ?? experiment.conclusion ?? "" },
  ]

  const references = (experiment.linked_papers ?? []).map((paper, index) => ({
    id: resourceId("reference", paper, index),
    kind: "reference" as const,
    title: paper,
    href: asHref(paper),
  }))

  const artifacts: ResearchRecordResource[] = []
  for (const attachment of experiment.attachment_refs ?? []) {
    artifacts.push({
      id: `artifact:document:${attachment.attachmentId}`,
      kind: "artifact",
      title: attachment.title,
      mediaType: attachment.mediaType,
      ref: attachment.ref,
      revisionSha256: attachment.revisionSha256,
      contentSha256: attachment.contentSha256,
      documentRevisionId: attachment.documentRevisionId,
    })
  }
  for (const observation of experiment.observation_refs ?? []) {
    artifacts.push({
      id: `artifact:eln-observation:${observation.id}`,
      kind: "artifact",
      title: `Observation at ${observation.observedAt}`,
      mediaType: "application/vnd.galaxy.eln-observation+json",
      excerpt: observation.body,
      ref: observation.ref,
      revisionSha256: observation.revisionSha256,
    })
  }
  if (configSnapshot && Object.keys(configSnapshot).length > 0) {
    artifacts.push({
      id: `artifact:config:${experiment.id}`,
      kind: "artifact",
      title: "Configuration snapshot",
      mediaType: "application/json",
      excerpt: JSON.stringify(configSnapshot, null, 2),
    })
  }
  const wandbRunId = draft.wandb_run_id ?? experiment.wandb_run_id
  const wandbProject = draft.wandb_project ?? experiment.wandb_project
  const localRunPath = draft.local_run_path ?? experiment.local_run_path
  if (wandbRunId) {
    const wandbHref = buildWandbRunUrl(wandbProject ?? "", wandbRunId)
    artifacts.push({
      id: `artifact:wandb:${wandbRunId}`,
      kind: "artifact",
      title: `Weights & Biases run ${wandbRunId}`,
      href: wandbHref ?? undefined,
      mediaType: "application/vnd.wandb.run",
    })
  }
  if (localRunPath) {
    artifacts.push({
      id: resourceId("artifact:run", localRunPath, 0),
      kind: "artifact",
      title: localRunPath,
      mediaType: "application/vnd.galaxy-brain.local-run",
    })
  }

  return {
    schemaVersion: RESEARCH_RECORD_SCHEMA_VERSION,
    id: experiment.id,
    kind: "eln-research-record",
    title: draft.title ?? experiment.title,
    status: draft.status ?? experiment.status,
    domain: draft.domain ?? experiment.domain ?? "general",
    tags: draft.tags ?? experiment.tags ?? [],
    sections,
    references,
    artifacts,
    metrics: (experiment.metrics ?? []).map((metric, index) => ({
      id: String(metric.id ?? `${experiment.id}:${index}`),
      name: metric.name,
      value: metric.value,
      step: metric.step,
      source: metric.source,
      timestamp: metric.timestamp,
    })),
    linkedRecordIds: draft.linked_experiments ?? experiment.linked_experiments ?? [],
    provenance: {
      source: "galaxy-brain-eln",
      tenantId: experiment.tenant_id,
      principalId: experiment.created_by_principal_id,
      hamNodeId: experiment.ham_node_id,
      createdAt: experiment.created_at,
      updatedAt: experiment.updated_at,
    },
  }
}

function markdownValue(value: string) {
  return value.trim() || "_Not recorded._"
}

export function researchRecordToMarkdown(record: ResearchRecordDocument) {
  const sections = record.sections
    .map((section) => `## ${section.title}\n${markdownValue(section.content)}`)
    .join("\n\n")
  const references = record.references.length > 0
    ? record.references
        .map((reference) => `- ${reference.href ? `[${reference.title}](${reference.href})` : reference.title}`)
        .join("\n")
    : "- _No references attached._"
  const artifacts = record.artifacts.length > 0
    ? record.artifacts
        .map((artifact) => `- ${artifact.href ? `[${artifact.title}](${artifact.href})` : artifact.title}${artifact.mediaType ? ` (${artifact.mediaType})` : ""}${artifact.ref ? ` — \`${artifact.ref}\`` : ""}${artifact.revisionSha256 ? ` — revision sha256 \`${artifact.revisionSha256}\`` : ""}${artifact.contentSha256 ? ` — content sha256 \`${artifact.contentSha256}\`` : ""}`)
        .join("\n")
    : "- _No artifacts attached._"
  const tags = record.tags.length > 0 ? record.tags.map((tag) => `\`${tag}\``).join(" ") : "_None_"

  return `# ${record.title}

- **Status:** ${record.status}
- **Domain:** ${record.domain}
- **Record:** \`${record.id}\`
- **Schema:** \`${record.schemaVersion}\`

${sections}

## Legacy references
${references}

## Pinned artifact manifest
${artifacts}

## Tags
${tags}

---
Updated ${record.provenance.updatedAt} from ${record.provenance.source}.
`
}
