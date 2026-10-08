import { createPluginRegistry } from "./registry.js"

function descriptor(kind, implementationId) {
  return Object.freeze({ kind, implementationId })
}

export const HAM_PLUGIN_PACKAGE = Object.freeze({
  manifest: Object.freeze({
    schemaId: "galaxy-plugin.v1",
    id: "ham",
    displayName: "HAM",
    version: "1.0.0",
    contributes: Object.freeze({
      commands: Object.freeze(["ham.memory.search.open"]),
      sources: Object.freeze(["ham.memory"]),
      transforms: Object.freeze([]),
      projectors: Object.freeze(["ham-memory"]),
      surfaceRenderers: Object.freeze([]),
      agentTools: Object.freeze(["ham.memory.search"]),
      routes: Object.freeze(["ham.proxy"]),
    }),
    connections: Object.freeze(["ham.internal"]),
  }),
  handlers: Object.freeze({
    commands: Object.freeze({
      "ham.memory.search.open": descriptor("commands", "builtin.ham.memory-search.open"),
    }),
    sources: Object.freeze({
      "ham.memory": descriptor("sources", "builtin.ham.memory-source"),
    }),
    projectors: Object.freeze({
      "ham-memory": descriptor("projectors", "builtin.object-projector.ham-memory"),
    }),
    agentTools: Object.freeze({
      "ham.memory.search": descriptor("agentTools", "builtin.ham.memory-search"),
    }),
    routes: Object.freeze({
      "ham.proxy": descriptor("routes", "builtin.ham.proxy"),
    }),
    connections: Object.freeze({
      "ham.internal": descriptor("connections", "builtin.ham.internal-connection"),
    }),
  }),
})

export const MARKITDOWN_PLUGIN_PACKAGE = Object.freeze({
  manifest: Object.freeze({
    schemaId: "galaxy-plugin.v1",
    id: "markitdown",
    displayName: "MarkItDown",
    version: "1.0.0",
    contributes: Object.freeze({
      commands: Object.freeze([]),
      sources: Object.freeze([]),
      transforms: Object.freeze(["markitdown.convert"]),
      projectors: Object.freeze([]),
      surfaceRenderers: Object.freeze([]),
      agentTools: Object.freeze([]),
      routes: Object.freeze(["markitdown.convert-route"]),
    }),
    connections: Object.freeze(["markitdown.internal"]),
  }),
  handlers: Object.freeze({
    transforms: Object.freeze({
      "markitdown.convert": descriptor("transforms", "builtin.markitdown.convert"),
    }),
    routes: Object.freeze({
      "markitdown.convert-route": descriptor("routes", "builtin.markitdown.convert-route"),
    }),
    connections: Object.freeze({
      "markitdown.internal": descriptor("connections", "builtin.markitdown.internal-connection"),
    }),
  }),
})

export const DOCLING_PLUGIN_PACKAGE = Object.freeze({
  manifest: Object.freeze({
    schemaId: "galaxy-plugin.v1",
    id: "docling",
    displayName: "Docling",
    version: "1.0.0",
    contributes: Object.freeze({
      commands: Object.freeze([]), sources: Object.freeze([]),
      transforms: Object.freeze(["docling.convert"]), projectors: Object.freeze([]),
      surfaceRenderers: Object.freeze([]), agentTools: Object.freeze([]),
      routes: Object.freeze(["docling.convert-route"]),
    }),
    connections: Object.freeze(["docling.internal"]),
  }),
  handlers: Object.freeze({
    transforms: Object.freeze({ "docling.convert": descriptor("transforms", "builtin.docling.convert") }),
    routes: Object.freeze({ "docling.convert-route": descriptor("routes", "builtin.docling.convert-route") }),
    connections: Object.freeze({ "docling.internal": descriptor("connections", "builtin.docling.internal-connection") }),
  }),
})

export const PLAIN_TEXT_PLUGIN_PACKAGE = Object.freeze({
  manifest: Object.freeze({
    schemaId: "galaxy-plugin.v1",
    id: "plain-text",
    displayName: "Plain text",
    version: "1.0.0",
    contributes: Object.freeze({
      commands: Object.freeze([]),
      sources: Object.freeze([]),
      transforms: Object.freeze(["plain-text.convert"]),
      projectors: Object.freeze([]),
      surfaceRenderers: Object.freeze([]),
      agentTools: Object.freeze([]),
      routes: Object.freeze([]),
    }),
    connections: Object.freeze([]),
  }),
  handlers: Object.freeze({
    transforms: Object.freeze({
      "plain-text.convert": descriptor("transforms", "builtin.plain-text.convert"),
    }),
  }),
})

export const DOCUMENTS_PLUGIN_PACKAGE = Object.freeze({
  manifest: Object.freeze({
    schemaId: "galaxy-plugin.v1",
    id: "documents",
    displayName: "Documents",
    version: "1.0.0",
    contributes: Object.freeze({
      commands: Object.freeze(["document.import", "document.note.create"]),
      sources: Object.freeze(["document.upload"]),
      transforms: Object.freeze([]),
      projectors: Object.freeze(["audio", "image", "document", "document-anchor", "markdown", "media", "paper"]),
      surfaceRenderers: Object.freeze([]),
      agentTools: Object.freeze(["anchors.create"]),
      routes: Object.freeze(["document.import-route"]),
      ingestionPlans: Object.freeze(["document.upload-default"]),
    }),
    connections: Object.freeze([]),
  }),
  handlers: Object.freeze({
    commands: Object.freeze({
      "document.import": descriptor("commands", "builtin.document.import"),
      "document.note.create": descriptor("commands", "builtin.document.note.create"),
    }),
    sources: Object.freeze({
      "document.upload": descriptor("sources", "builtin.document.upload-source"),
    }),
    projectors: Object.freeze({
      audio: descriptor("projectors", "builtin.object-projector.audio"),
      image: descriptor("projectors", "builtin.object-projector.image"),
      document: descriptor("projectors", "builtin.object-projector.document"),
      "document-anchor": descriptor("projectors", "builtin.object-projector.document-anchor"),
      markdown: descriptor("projectors", "builtin.object-projector.markdown"),
      media: descriptor("projectors", "builtin.object-projector.media"),
      paper: descriptor("projectors", "builtin.object-projector.paper"),
    }),
    routes: Object.freeze({
      "document.import-route": descriptor("routes", "builtin.document.import-route"),
    }),
    ingestionPlans: Object.freeze({
      "document.upload-default": descriptor(
        "ingestionPlans",
        "builtin.ingestion-plan.document-upload-default",
      ),
    }),
    agentTools: Object.freeze({
      "anchors.create": descriptor("agentTools", "builtin.anchors.create"),
    }),
  }),
})

export const DATASOURCES_PLUGIN_PACKAGE = Object.freeze({
  manifest: Object.freeze({
    schemaId: "galaxy-plugin.v1",
    id: "datasources",
    displayName: "Research datasources",
    version: "1.0.0",
    contributes: Object.freeze({
      commands: Object.freeze(["datasource.manage.open"]),
      sources: Object.freeze(["datasource.connected"]),
      transforms: Object.freeze([]),
      projectors: Object.freeze([]),
      surfaceRenderers: Object.freeze([]),
      agentTools: Object.freeze([]),
      routes: Object.freeze(["datasource.proxy"]),
      ingestionPlans: Object.freeze(["datasource.file-default"]),
    }),
    connections: Object.freeze([]),
  }),
  handlers: Object.freeze({
    commands: Object.freeze({
      "datasource.manage.open": descriptor("commands", "builtin.datasource.manage.open"),
    }),
    sources: Object.freeze({
      "datasource.connected": descriptor("sources", "builtin.datasource.connected-source"),
    }),
    routes: Object.freeze({
      "datasource.proxy": descriptor("routes", "builtin.datasource.proxy-route"),
    }),
    ingestionPlans: Object.freeze({
      "datasource.file-default": descriptor(
        "ingestionPlans",
        "builtin.ingestion-plan.datasource-file-default",
      ),
    }),
  }),
})

export const WEB_CAPTURE_PLUGIN_PACKAGE = Object.freeze({
  manifest: Object.freeze({
    schemaId: "galaxy-plugin.v1",
    id: "web-capture",
    displayName: "Web capture",
    version: "1.0.0",
    contributes: Object.freeze({
      commands: Object.freeze(["web.capture.open"]),
      sources: Object.freeze(["web.capture"]),
      transforms: Object.freeze([]),
      projectors: Object.freeze([]),
      surfaceRenderers: Object.freeze([]),
      agentTools: Object.freeze([]),
      routes: Object.freeze(["web.capture-route"]),
      ingestionPlans: Object.freeze(["web.capture-default"]),
    }),
    connections: Object.freeze([]),
  }),
  handlers: Object.freeze({
    commands: Object.freeze({
      "web.capture.open": descriptor("commands", "builtin.web.capture.open"),
    }),
    sources: Object.freeze({
      "web.capture": descriptor("sources", "builtin.web.capture-source"),
    }),
    routes: Object.freeze({
      "web.capture-route": descriptor("routes", "builtin.web.capture-route"),
    }),
    ingestionPlans: Object.freeze({
      "web.capture-default": descriptor(
        "ingestionPlans",
        "builtin.ingestion-plan.web-capture-default",
      ),
    }),
  }),
})

export const PAPERS_PLUGIN_PACKAGE = Object.freeze({
  manifest: Object.freeze({
    schemaId: "galaxy-plugin.v1",
    id: "papers",
    displayName: "Papers",
    version: "1.0.0",
    contributes: Object.freeze({
      commands: Object.freeze(["paper.import"]),
      sources: Object.freeze(["arxiv.pdf"]),
      transforms: Object.freeze([]),
      projectors: Object.freeze([]),
      surfaceRenderers: Object.freeze([]),
      agentTools: Object.freeze([]),
      routes: Object.freeze(["arxiv.private-fetch-route"]),
      ingestionPlans: Object.freeze(["arxiv.fetch-default"]),
    }),
    connections: Object.freeze([]),
  }),
  handlers: Object.freeze({
    commands: Object.freeze({
      "paper.import": descriptor("commands", "builtin.paper.import"),
    }),
    sources: Object.freeze({
      "arxiv.pdf": descriptor("sources", "builtin.arxiv.pdf-source"),
    }),
    routes: Object.freeze({
      "arxiv.private-fetch-route": descriptor("routes", "builtin.arxiv.private-fetch-route"),
    }),
    ingestionPlans: Object.freeze({
      "arxiv.fetch-default": descriptor(
        "ingestionPlans",
        "builtin.ingestion-plan.arxiv-fetch-default",
      ),
    }),
  }),
})

export const ELN_PLUGIN_PACKAGE = Object.freeze({
  manifest: Object.freeze({
    schemaId: "galaxy-plugin.v1",
    id: "eln",
    displayName: "Electronic lab notebook",
    version: "1.1.0",
    contributes: Object.freeze({
      commands: Object.freeze(["eln.experiment.create"]),
      sources: Object.freeze([]),
      transforms: Object.freeze([]),
      projectors: Object.freeze(["eln"]),
      surfaceRenderers: Object.freeze([]),
      agentTools: Object.freeze([]),
      routes: Object.freeze([]),
    }),
    connections: Object.freeze([]),
  }),
  handlers: Object.freeze({
    commands: Object.freeze({
      "eln.experiment.create": descriptor("commands", "builtin.eln.experiment.create"),
    }),
    projectors: Object.freeze({
      eln: descriptor("projectors", "builtin.object-projector.eln"),
    }),
  }),
})

export const CODE_PLUGIN_PACKAGE = Object.freeze({
  manifest: Object.freeze({
    schemaId: "galaxy-plugin.v1",
    id: "code",
    displayName: "Code editor",
    version: "1.0.0",
    contributes: Object.freeze({
      commands: Object.freeze(["code.editor.open", "code.graph.snapshot.import"]),
      sources: Object.freeze(["code.graph.snapshot"]),
      transforms: Object.freeze([]),
      projectors: Object.freeze(["code"]),
      surfaceRenderers: Object.freeze([]),
      agentTools: Object.freeze([]),
      routes: Object.freeze([]),
    }),
    connections: Object.freeze([]),
  }),
  handlers: Object.freeze({
    commands: Object.freeze({
      "code.editor.open": descriptor("commands", "builtin.code.editor.open"),
      "code.graph.snapshot.import": descriptor("commands", "builtin.code.graph.snapshot.import"),
    }),
    sources: Object.freeze({
      "code.graph.snapshot": descriptor("sources", "builtin.code.graph.snapshot-source"),
    }),
    projectors: Object.freeze({
      code: descriptor("projectors", "builtin.object-projector.code"),
    }),
  }),
})

export const VOICE_PLUGIN_PACKAGE = Object.freeze({
  manifest: Object.freeze({
    schemaId: "galaxy-plugin.v1",
    id: "voice",
    displayName: "Voice input",
    version: "1.0.0",
    contributes: Object.freeze({
      commands: Object.freeze(["voice.capture.open"]),
      sources: Object.freeze([]),
      transforms: Object.freeze([]),
      projectors: Object.freeze([]),
      surfaceRenderers: Object.freeze([]),
      agentTools: Object.freeze([]),
      routes: Object.freeze([]),
    }),
    connections: Object.freeze([]),
  }),
  handlers: Object.freeze({
    commands: Object.freeze({
      "voice.capture.open": descriptor("commands", "builtin.voice.capture.open"),
    }),
  }),
})

export const GENEROUS_PLUGIN_PACKAGE = Object.freeze({
  manifest: Object.freeze({
    schemaId: "galaxy-plugin.v1",
    id: "generous",
    displayName: "Generous",
    version: "1.0.0",
    contributes: Object.freeze({
      commands: Object.freeze(["surface.place.open"]),
      sources: Object.freeze([]),
      transforms: Object.freeze([]),
      projectors: Object.freeze(["surface"]),
      surfaceRenderers: Object.freeze(["generous.a2ui"]),
      agentTools: Object.freeze(["surface.draft.create"]),
      routes: Object.freeze([]),
    }),
    connections: Object.freeze([]),
  }),
  handlers: Object.freeze({
    commands: Object.freeze({
      "surface.place.open": descriptor("commands", "builtin.surface.place.open"),
    }),
    projectors: Object.freeze({
      surface: descriptor("projectors", "builtin.object-projector.surface"),
    }),
    surfaceRenderers: Object.freeze({
      "generous.a2ui": descriptor("surfaceRenderers", "builtin.surface-renderer.generous-a2ui"),
    }),
    agentTools: Object.freeze({
      "surface.draft.create": descriptor("agentTools", "builtin.surface.draft.create"),
    }),
  }),
})

export const TASKS_PLUGIN_PACKAGE = Object.freeze({
  manifest: Object.freeze({
    schemaId: "galaxy-plugin.v1",
    id: "tasks",
    displayName: "Tasks",
    version: "1.0.0",
    contributes: Object.freeze({
      commands: Object.freeze([
        "legacy.flow.portability.open", "proof.package.import", "proof.registry.open", "task.plan.open",
      ]),
      sources: Object.freeze([]),
      transforms: Object.freeze([]),
      projectors: Object.freeze(["conversation", "proof", "task"]),
      surfaceRenderers: Object.freeze([]),
      agentTools: Object.freeze([
        "proof.frontier.get", "proof.graph.get", "proof.claim", "task.plan.get", "task.plan.propose",
      ]),
      routes: Object.freeze([]),
    }),
    connections: Object.freeze([]),
  }),
  handlers: Object.freeze({
    commands: Object.freeze({
      "legacy.flow.portability.open": descriptor("commands", "builtin.legacy.flow.portability.open"),
      "proof.package.import": descriptor("commands", "builtin.proof.package.import"),
      "proof.registry.open": descriptor("commands", "builtin.proof.registry.open"),
      "task.plan.open": descriptor("commands", "builtin.task.plan.open"),
    }),
    projectors: Object.freeze({
      conversation: descriptor("projectors", "builtin.object-projector.conversation"),
      proof: descriptor("projectors", "builtin.object-projector.proof"),
      task: descriptor("projectors", "builtin.object-projector.task"),
    }),
    agentTools: Object.freeze({
      "proof.frontier.get": descriptor("agentTools", "builtin.proof.frontier.get"),
      "proof.graph.get": descriptor("agentTools", "builtin.proof.graph.get"),
      "proof.claim": descriptor("agentTools", "builtin.proof.claim"),
      "task.plan.get": descriptor("agentTools", "builtin.task.plan.get"),
      "task.plan.propose": descriptor("agentTools", "builtin.task.plan.propose"),
    }),
  }),
})

export const SHARING_PLUGIN_PACKAGE = Object.freeze({
  manifest: Object.freeze({
    schemaId: "galaxy-plugin.v1",
    id: "sharing",
    displayName: "Sharing",
    version: "1.0.0",
    contributes: Object.freeze({
      commands: Object.freeze([
        "share.canvas.create",
        "share.canvas-conversation.create",
        "share.selection.create",
      ]),
      sources: Object.freeze([]),
      transforms: Object.freeze([]),
      projectors: Object.freeze([]),
      surfaceRenderers: Object.freeze([]),
      agentTools: Object.freeze([]),
      routes: Object.freeze([]),
    }),
    connections: Object.freeze([]),
  }),
  handlers: Object.freeze({
    commands: Object.freeze({
      "share.canvas.create": descriptor("commands", "builtin.share.canvas.create"),
      "share.canvas-conversation.create": descriptor("commands", "builtin.share.canvas-conversation.create"),
      "share.selection.create": descriptor("commands", "builtin.share.selection.create"),
    }),
  }),
})

export const ATLAS_PLUGIN_PACKAGE = Object.freeze({
  manifest: Object.freeze({
    schemaId: "galaxy-plugin.v1",
    id: "atlas",
    displayName: "Atlas",
    version: "1.0.0",
    contributes: Object.freeze({
      commands: Object.freeze(["canvas.create.open", "frame.create.open", "frame.remove", "ink.draw.open", "placement.remove", "reference.place", "relations.review.open"]),
      sources: Object.freeze([]),
      transforms: Object.freeze([]),
      projectors: Object.freeze([]),
      surfaceRenderers: Object.freeze([]),
      agentTools: Object.freeze([
        "canvas.arrange", "canvas.get", "graph.window.get", "objects.get", "objects.representations", "objects.search", "relations.propose",
      ]),
      routes: Object.freeze([]),
    }),
    connections: Object.freeze([]),
  }),
  handlers: Object.freeze({
    commands: Object.freeze({
      "canvas.create.open": descriptor("commands", "builtin.canvas.create.open"),
      "frame.create.open": descriptor("commands", "builtin.frame.create.open"),
      "frame.remove": descriptor("commands", "builtin.frame.remove"),
      "ink.draw.open": descriptor("commands", "builtin.ink.draw.open"),
      "placement.remove": descriptor("commands", "builtin.placement.remove"),
      "reference.place": descriptor("commands", "builtin.reference.place"),
      "relations.review.open": descriptor("commands", "builtin.relations.review.open"),
    }),
    agentTools: Object.freeze({
      "canvas.arrange": descriptor("agentTools", "builtin.canvas.arrange"),
      "canvas.get": descriptor("agentTools", "builtin.canvas.get"),
      "graph.window.get": descriptor("agentTools", "builtin.graph.window.get"),
      "objects.get": descriptor("agentTools", "builtin.objects.get"),
      "objects.representations": descriptor("agentTools", "builtin.objects.representations"),
      "objects.search": descriptor("agentTools", "builtin.objects.search"),
      "relations.propose": descriptor("agentTools", "builtin.relations.propose"),
    }),
  }),
})

export const BUILTIN_PLUGIN_PACKAGES = Object.freeze([
  ATLAS_PLUGIN_PACKAGE,
  CODE_PLUGIN_PACKAGE,
  DATASOURCES_PLUGIN_PACKAGE,
  DOCUMENTS_PLUGIN_PACKAGE,
  ELN_PLUGIN_PACKAGE,
  GENEROUS_PLUGIN_PACKAGE,
  HAM_PLUGIN_PACKAGE,
  DOCLING_PLUGIN_PACKAGE,
  MARKITDOWN_PLUGIN_PACKAGE,
  PAPERS_PLUGIN_PACKAGE,
  PLAIN_TEXT_PLUGIN_PACKAGE,
  SHARING_PLUGIN_PACKAGE,
  TASKS_PLUGIN_PACKAGE,
  VOICE_PLUGIN_PACKAGE,
  WEB_CAPTURE_PLUGIN_PACKAGE,
])

export const builtinPluginRegistry = createPluginRegistry(BUILTIN_PLUGIN_PACKAGES)
