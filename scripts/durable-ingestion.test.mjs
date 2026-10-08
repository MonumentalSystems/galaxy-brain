import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { builtinPluginRegistry } from "../lib/plugins/builtins.js"

test("durable import is bounded, preserves exact bytes, and exposes no caller-selected converter URL", async () => {
  const [route, server, compose, environment] = await Promise.all([
    readFile(new URL("../app/api/eln/[...path]/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../services/galaxy-brain-api/server.py", import.meta.url), "utf8"),
    readFile(new URL("../docker-compose.yml", import.meta.url), "utf8")
      .then((value) => value.replaceAll("\r\n", "\n")),
    readFile(new URL("../.env.example", import.meta.url), "utf8"),
  ])
  assert.match(route, /MAX_DOCUMENT_IMPORT_BODY_BYTES = 100_000_000/)
  assert.match(route, /path\[1\] === "import"/)
  assert.match(route, /"Idempotency-Key", "X-GB-Import-Metadata"/)
  assert.match(route, /MAX_DOCUMENT_IMPORT_METADATA_HEADER_CHARS = 8_000/)
  assert.doesNotMatch(route, /X-GB-Filename|X-GB-Title|X-GB-Source-URI/)
  assert.match(server, /@app\.post\("\/documents\/import"/)
  assert.match(server, /psycopg2\.Binary\(raw\)/)
  assert.match(server, /pg_advisory_xact_lock\(hashtext\('gb_document_import'\), hashtext\(%s\)\)/)
  assert.match(server, /Document import idempotency key was reused/)
  assert.match(server, /decode_import_metadata/)
  assert.doesNotMatch(route, /X-GB-Transform-URL|X-GB-Docling-URL/)
  assert.match(compose, /DOCLING_API_INTERNAL/)
  assert.match(environment, /DOCLING_API_KEY=/)
  assert.match(environment, /DOCLING_ENGINE_VERSION=/)
})

test("Docling and fallback engines have explicit, server-owned contracts", async () => {
  const [pythonContract, adapters, api, proxy, markitdownRequirements, markitdownServer, markitdownWorker, markitdownDockerfile, compose] = await Promise.all([
    readFile(new URL("../services/galaxy-brain-api/durable_ingestion.py", import.meta.url), "utf8"),
    readFile(new URL("../services/galaxy-brain-api/document_transform_adapters.py", import.meta.url), "utf8"),
    readFile(new URL("../services/galaxy-brain-api/server.py", import.meta.url), "utf8"),
    readFile(new URL("../app/api/eln/[...path]/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../services/markitdown-server/requirements.txt", import.meta.url), "utf8"),
    readFile(new URL("../services/markitdown-server/server.py", import.meta.url), "utf8"),
    readFile(new URL("../services/markitdown-server/worker.py", import.meta.url), "utf8"),
    readFile(new URL("../services/markitdown-server/Dockerfile", import.meta.url), "utf8"),
    readFile(new URL("../docker-compose.yml", import.meta.url), "utf8")
      .then((value) => value.replaceAll("\r\n", "\n")),
  ])
  assert.equal(builtinPluginRegistry.resolve("transforms", "docling.convert")?.pluginId, "docling")
  assert.equal(builtinPluginRegistry.resolve("transforms", "markitdown.convert")?.pluginId, "markitdown")
  assert.equal(builtinPluginRegistry.resolve("transforms", "plain-text.convert")?.pluginId, "plain-text")
  assert.match(pythonContract, /gb\.document-structure\.v1/)
  assert.match(pythonContract, /readingOrder/)
  assert.match(api, /@app\.post\("\/documents\/\{revision_id\}\/transform"/)
  assert.match(api, /execute_document_transform_adapter\(/)
  assert.match(api, /DOCLING_IMPLEMENTATION_ID/)
  assert.match(adapters, /DOCLING_IMPLEMENTATION_ID = "builtin\.docling\.convert"/)
  assert.match(adapters, /MARKITDOWN_IMPLEMENTATION_ID = "builtin\.markitdown\.convert"/)
  assert.match(adapters, /PLAIN_TEXT_IMPLEMENTATION_ID = "builtin\.plain-text\.convert"/)
  assert.match(adapters, /base_environment="DOCLING_API_INTERNAL"/)
  assert.match(adapters, /endpoint="v1\/convert\/file\/async"/)
  assert.match(adapters, /endpoint=f"v1\/status\/poll\//)
  assert.match(adapters, /endpoint=f"v1\/result\//)
  assert.match(adapters, /token_environment="DOCLING_API_KEY"/)
  assert.match(api, /fallback_plugin_for_filename\(filename\)/)
  assert.match(api, /INSERT INTO gb_transform_attempts/)
  assert.match(api, /lease_expires_at/)
  assert.match(api, /_TRANSFORM_SEMAPHORE\.acquire\(blocking=False\)/)
  assert.match(adapters, /_RejectTransformRedirects/)
  assert.match(adapters, /read_one\(min\(32_768, MAX_TRANSFORM_OUTPUT_BYTES/)
  assert.doesNotMatch(api, /pg_advisory_xact_lock\(hashtext\('gb_document_transform'/)
  assert.match(api, /Document transform idempotency key was reused/)
  assert.match(api, /WHERE tenant_id = %s AND request_sha256 = %s/)
  assert.match(adapters, /file_field="files"/)
  assert.match(adapters, /form_fields=fields/)
  assert.match(adapters, /\("do_formula_enrichment", "false"\)/)
  assert.match(adapters, /\("image_export_mode", "embedded"\)/)
  assert.match(adapters, /"\.docx"/)
  assert.match(adapters, /"\.html"/)
  assert.match(api, /document_transform_adapter_fingerprint\(\)/)
  assert.match(pythonContract, /"adapterFingerprint": adapter_fingerprint/)
  assert.match(pythonContract, /MARKITDOWN_EXTENSIONS = frozenset\(\{"\.pdf", "\.docx", "\.html", "\.htm"\}\)/)
  assert.match(markitdownRequirements, /markitdown\[all\]==0\.1\.8/)
  assert.match(markitdownServer, /"engine_version": MARKITDOWN_ENGINE_VERSION/)
  assert.match(markitdownServer, /process\.wait\(timeout=WORKER_TIMEOUT_SECONDS\)/)
  assert.match(markitdownServer, /os\.killpg\(process\.pid, signal\.SIGKILL\)/)
  assert.match(markitdownServer, /output_path\.read_bytes\(\)\.decode\("utf-8", errors="strict"\)/)
  assert.match(markitdownServer, /file\.read\(MAX_FILE_SIZE \+ 1\)/)
  assert.match(markitdownServer, /extension == "\.pdf" and not content\.startswith\(b"%PDF-"\)/)
  assert.match(markitdownServer, /SUPPORTED_EXTENSIONS/)
  assert.doesNotMatch(markitdownServer, /str\(e\)|str\(error\)/)
  assert.match(markitdownWorker, /if len\(encoded\) > max_output_bytes:/)
  assert.match(markitdownWorker, /output_path\.open\("xb"\)/)
  assert.match(markitdownDockerfile, /USER 10001:10001/)
  assert.match(markitdownDockerfile, /COPY --chown=galaxy:galaxy server\.py worker\.py/)
  assert.match(compose, /read_only: true/)
  assert.match(compose, /no-new-privileges:true/)
  assert.match(compose, /pids_limit: 64/)
  assert.match(compose, /markitdown-internal:\n\s+internal: true/)
  assert.match(api, /@app\.get\("\/documents\/\{revision_id\}\/representations"/)
  assert.match(proxy, /path\[2\] === "transform"/)
  assert.match(proxy, /path\[2\] === "representations"/)
  assert.match(proxy, /Document transform accepts no request body/)
  assert.match(proxy, /X-GB-Transform-Mode/)
  assert.match(proxy, /"Retry-After"/)
  assert.doesNotMatch(api, /x-gb-(?:transform|docling|markitdown)-(?:url|endpoint)/i)
  assert.doesNotMatch(proxy, /X-GB-(?:Transform|Docling|MarkItDown)-(?:URL|Endpoint)/)
})

test("Docling runtime is pinned, private, bounded, and optional to Galaxy API startup", async () => {
  const compose = (await readFile(new URL("../docker-compose.yml", import.meta.url), "utf8")).replaceAll("\r\n", "\n")
  const docling = compose.split("\n  docling:\n", 2)[1].split("\n  markitdown:\n", 1)[0]
  const api = compose.split("\n  galaxy-brain-api:\n", 2)[1].split("\n  web:\n", 1)[0]
  const apiDependsOn = api.split("\n    depends_on:\n", 2)[1].split("\n    restart:", 1)[0]
  const web = compose.split("\n  web:\n", 2)[1].split("\nvolumes:\n", 1)[0]

  assert.match(docling, /quay\.io\/docling-project\/docling-serve-cpu:v1\.35\.0@sha256:79e5fcd19ab227ed36323fa5fa31820d14d53efc4f073417ba37be7931c7af0a/)
  assert.match(docling, /DOCLING_SERVE_API_KEY: \$\{GALAXY_DEPLOY_DOCLING_API_KEY/)
  assert.match(docling, /DOCLING_SERVE_MAX_NUM_PAGES: 500/)
  assert.match(docling, /DOCLING_SERVE_MAX_FILE_SIZE: 26214400/)
  assert.match(docling, /\/ready/)
  assert.match(docling, /read_only: true/)
  assert.match(docling, /user: "1001:1001"/)
  assert.match(docling, /cap_drop:\n\s+- ALL/)
  assert.match(docling, /no-new-privileges:true/)
  assert.match(docling, /pids_limit: 256/)
  assert.match(docling, /mem_limit: 8g/)
  assert.match(docling, /cpus: 4\.0/)
  assert.match(docling, /- docling-internal/)
  assert.doesNotMatch(docling, /\n\s+ports:/)
  assert.match(compose, /docling-internal:\n\s+internal: true/)

  assert.match(api, /DOCLING_API_INTERNAL: http:\/\/docling:5001/)
  assert.match(api, /DOCLING_ENGINE_VERSION: \$\{DOCLING_ENGINE_VERSION:-2\.130\.0\}/)
  assert.match(api, /- docling-internal/)
  assert.doesNotMatch(apiDependsOn, /docling/)
  assert.doesNotMatch(web, /DOCLING_(?:API|ENGINE|SERVE)/)
  assert.doesNotMatch(web, /docling-internal/)
})
