export const fixturePluginPackage = Object.freeze({
  manifest: Object.freeze({
    schemaId: "galaxy-plugin.v1",
    id: "fixture-research",
    displayName: "Fixture research",
    version: "1.2.3",
    contributes: Object.freeze({
      commands: Object.freeze(["fixture.capture"]),
      transforms: Object.freeze(["fixture.normalize"]),
      projectors: Object.freeze(["fixture.card"]),
    }),
    connections: Object.freeze([]),
  }),
  handlers: Object.freeze({
    commands: Object.freeze({
      "fixture.capture": Object.freeze({
        kind: "commands",
        implementationId: "fixture.capture-command",
      }),
    }),
    transforms: Object.freeze({
      "fixture.normalize": Object.freeze({
        kind: "transforms",
        implementationId: "fixture.normalize-transform",
      }),
    }),
    projectors: Object.freeze({
      "fixture.card": Object.freeze({
        kind: "projectors",
        implementationId: "fixture.card-projector",
      }),
    }),
  }),
})
