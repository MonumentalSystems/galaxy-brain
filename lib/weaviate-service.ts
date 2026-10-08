/**
 * Backwards-compatible re-export from HAM service.
 *
 * All components import from "@/lib/weaviate-service" — this file
 * now delegates to the optional HAM-compatible memory backend.
 *
 * The original localStorage-based implementation is preserved at
 * weaviate-service-original.ts.
 */

export {
  hamService as weaviateService,
  type KnowledgeNode,
  type KnowledgeEdge,
  type SearchResult,
  type Workspace,
  type NodeType,
} from "./ham-service"
