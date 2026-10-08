"use client"

import { Download } from "lucide-react"

import { Button } from "@/components/ui/button"
import { toast } from "@/components/ui/use-toast"
import { safeLocalStorage } from "@/lib/browser-utils"
import { createLegacyFlowExportFromStorage, LEGACY_FLOW_EXPORT_FILE_NAME } from "@/lib/legacy-flow-export"

export function FlowExport() {
  const download = () => {
    const result = createLegacyFlowExportFromStorage(safeLocalStorage())
    if (!result.bundle || !result.json) {
      toast({
        title: "Export unavailable",
        description: result.diagnostics.find((item) => item.level === "error")?.message || "The local flow data is invalid.",
        variant: "destructive",
      })
      return
    }

    const objectUrl = URL.createObjectURL(new Blob([result.json], { type: "application/json" }))
    const anchor = document.createElement("a")
    anchor.href = objectUrl
    anchor.download = LEGACY_FLOW_EXPORT_FILE_NAME
    document.body.append(anchor)
    anchor.click()
    anchor.remove()
    URL.revokeObjectURL(objectUrl)

    const omissionCount = result.diagnostics.filter((item) => item.level === "warning").length
    toast({
      title: "Local flow export downloaded",
      description: `${result.bundle.flows.length} flow${result.bundle.flows.length === 1 ? "" : "s"} exported${omissionCount ? `; ${omissionCount} non-portable field group${omissionCount === 1 ? " was" : "s were"} excluded` : ""}.`,
    })
  }

  return (
    <Button type="button" variant="outline" size="sm" onClick={download}>
      <Download aria-hidden="true" />
      Export local flows
    </Button>
  )
}
