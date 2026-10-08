"use client"

import { useEffect, useState } from "react"
import { Loader2, Monitor, Moon, RefreshCw, Sun, Trash2 } from "lucide-react"
import { useTheme } from "next-themes"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { toast } from "@/components/ui/use-toast"
import { Input } from "@/components/ui/input"
import { contentProcessingService } from "@/lib/content-processing-service"
import { getDatasourceContentFingerprint } from "@/lib/datasource-node-actions"
import { type GalaxyWorkspace, galaxyBrainService } from "@/lib/galaxy-brain-service"
import { galaxyBrainAPI } from "@/lib/galaxy-brain-api"
import { weaviateService } from "@/lib/weaviate-service"
import { safeLocalStorage } from "@/lib/browser-utils"
import type { DatasourceConnection, DatasourceItem, DatasourcePluginManifest } from "@/lib/types/datasources"

type SettingsDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Which tab to show first */
  initialTab?: "general" | "tools" | "data"
  currentWorkspace?: GalaxyWorkspace | null
}

const CODE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".py", ".rs", ".go", ".java", ".c", ".cpp", ".h", ".rb", ".php", ".sh", ".sql",
  ".json", ".yaml", ".yml", ".toml", ".css", ".html", ".htm", ".xml",
])

function detectDatasourceNodeKind(item: DatasourceItem): { type: string; category: "ai" | "document" | "media" | "speech" | "knowledge" } {
  const path = (item.path || item.title || "").toLowerCase()
  const mime = (item.mime_type || "").toLowerCase()
  if (mime.startsWith("image/")) return { type: "image", category: "media" }
  if (mime.startsWith("video/")) return { type: "video", category: "media" }
  if (mime.startsWith("audio/")) return { type: "audio", category: "speech" }
  if (path.endsWith(".pdf")) return { type: "document", category: "document" }
  if (CODE_EXTENSIONS.has(path.slice(path.lastIndexOf(".")))) return { type: "code", category: "knowledge" }
  if (mime.startsWith("text/") || /\.(md|markdown|txt|csv|log|svg)$/.test(path)) return { type: "note", category: "knowledge" }
  return { type: "document", category: "document" }
}

function getImportedDatasourceNodeId(connectionId: string, itemId: string): string | null {
  const existing = galaxyBrainService.findNodeByDatasourceOrigin(connectionId, itemId)
  return existing?.id || null
}

export function SettingsDialog({ open, onOpenChange, initialTab = "general", currentWorkspace = null }: SettingsDialogProps) {
  const { theme, setTheme } = useTheme()
  const [activeTab, setActiveTab] = useState<"general" | "tools" | "data">(initialTab)
  const [confirmClear, setConfirmClear] = useState(false)

  const preferences = galaxyBrainService.getUserPreferences()
  // Earlier workspace switches could persist Field as a default even though
  // this setting intentionally offers only the primary desk projections.
  const [defaultView, setDefaultView] = useState(
    ["canvas", "graph", "list"].includes(preferences.viewMode || "") ? preferences.viewMode! : "canvas",
  )
  const [autoSave, setAutoSave] = useState(
    safeLocalStorage().getItem("galaxyAutoSave") !== "false",
  )
  const [showNodePreview, setShowNodePreview] = useState(
    safeLocalStorage().getItem("galaxyNodePreview") !== "false",
  )

  // AI tool defaults
  const [defaultModel, setDefaultModel] = useState(
    safeLocalStorage().getItem("galaxyDefaultModel") || "gpt-4",
  )
  const [defaultTemperature, setDefaultTemperature] = useState(
    safeLocalStorage().getItem("galaxyDefaultTemp") || "0.7",
  )
  const [expandAiTools, setExpandAiTools] = useState(
    safeLocalStorage().getItem("galaxyExpandAi") !== "false",
  )

  // HAM backend stats
  const [hamStats, setHamStats] = useState<any>(null)
  const [fieldStats, setFieldStats] = useState<any>(null)
  const [statsLoading, setStatsLoading] = useState(false)
  const [consolidating, setConsolidating] = useState(false)
  const [resettingHAM, setResettingHAM] = useState(false)
  const [confirmResetHAM, setConfirmResetHAM] = useState(false)
  const [datasourcePlugins, setDatasourcePlugins] = useState<DatasourcePluginManifest[]>([])
  const [datasourceConnections, setDatasourceConnections] = useState<DatasourceConnection[]>([])
  const [datasourceLoading, setDatasourceLoading] = useState(false)
  const [datasourceSaving, setDatasourceSaving] = useState(false)
  const [datasourceBrowsingId, setDatasourceBrowsingId] = useState<string | null>(null)
  const [datasourceImportingId, setDatasourceImportingId] = useState<string | null>(null)
  const [datasourceItemsByConnection, setDatasourceItemsByConnection] = useState<Record<string, DatasourceItem[]>>({})
  const [selectedPluginId, setSelectedPluginId] = useState("filesystem-vault")
  const [connectionName, setConnectionName] = useState("My Vault")
  const [connectionPath, setConnectionPath] = useState("")

  // Load HAM stats when the Data tab becomes active
  useEffect(() => {
    if (activeTab !== "data") return
    setStatsLoading(true)
    Promise.allSettled([weaviateService.hamStats(), weaviateService.hamFieldStats()])
      .then(([statsResult, fieldResult]) => {
        if (statsResult.status === "fulfilled") setHamStats(statsResult.value)
        if (fieldResult.status === "fulfilled") setFieldStats(fieldResult.value)
      })
      .finally(() => setStatsLoading(false))
  }, [activeTab])

  useEffect(() => {
    if (activeTab !== "data") return
    setDatasourceLoading(true)
    Promise.allSettled([galaxyBrainAPI.getDatasourcePlugins(), galaxyBrainAPI.getDatasourceConnections()])
      .then(([pluginsResult, connectionsResult]) => {
        if (pluginsResult.status === "fulfilled") {
          setDatasourcePlugins(pluginsResult.value)
          if (pluginsResult.value.length > 0 && !pluginsResult.value.find((p) => p.id === selectedPluginId)) {
            setSelectedPluginId(pluginsResult.value[0].id)
          }
        }
        if (connectionsResult.status === "fulfilled") setDatasourceConnections(connectionsResult.value)
      })
      .finally(() => setDatasourceLoading(false))
  }, [activeTab, selectedPluginId])

  const handleSave = () => {
    // General settings
    galaxyBrainService.updateUserPreferences({ viewMode: defaultView })
    safeLocalStorage().setItem("galaxyAutoSave", String(autoSave))
    safeLocalStorage().setItem("galaxyNodePreview", String(showNodePreview))

    // Tool settings
    safeLocalStorage().setItem("galaxyDefaultModel", defaultModel)
    safeLocalStorage().setItem("galaxyDefaultTemp", defaultTemperature)
    safeLocalStorage().setItem("galaxyExpandAi", String(expandAiTools))

    toast({ title: "Settings saved", description: "Your preferences have been updated" })
    onOpenChange(false)
  }

  const handleClearData = () => {
    if (!confirmClear) {
      setConfirmClear(true)
      return
    }

    safeLocalStorage().clear()

    toast({
      title: "Data cleared",
      description: "This tenant's browser data has been reset. Reload the page to start fresh.",
    })
    setConfirmClear(false)
  }

  const handleConsolidate = async () => {
    setConsolidating(true)
    try {
      const result = await weaviateService.hamConsolidate()
      if (!result) throw new Error("Server unreachable")
      toast({ title: "Memory consolidated", description: "Tier promotion complete." })
      // Refresh stats (partial failures are tolerated)
      const [statsResult, fieldResult] = await Promise.allSettled([weaviateService.hamStats(), weaviateService.hamFieldStats()])
      if (statsResult.status === "fulfilled") setHamStats(statsResult.value)
      if (fieldResult.status === "fulfilled") setFieldStats(fieldResult.value)
    } catch {
      toast({ title: "Consolidation failed", description: "Check that the HAM server is running.", variant: "destructive" })
    } finally {
      setConsolidating(false)
    }
  }

  const handleResetHAM = async () => {
    if (!confirmResetHAM) {
      setConfirmResetHAM(true)
      return
    }
    if (resettingHAM) return
    setResettingHAM(true)
    try {
      await weaviateService.hamReset()
      toast({ title: "HAM reset", description: "All memories cleared from the database." })
      setHamStats(null)
      setFieldStats(null)
    } catch {
      toast({ title: "Reset failed", description: "Check that the HAM server is running.", variant: "destructive" })
    } finally {
      setResettingHAM(false)
      setConfirmResetHAM(false)
    }
  }

  const refreshDatasources = async () => {
    setDatasourceLoading(true)
    try {
      const [plugins, connections] = await Promise.all([
        galaxyBrainAPI.getDatasourcePlugins(),
        galaxyBrainAPI.getDatasourceConnections(),
      ])
      setDatasourcePlugins(plugins)
      setDatasourceConnections(connections)
    } finally {
      setDatasourceLoading(false)
    }
  }

  const handleBrowseDatasource = async (connectionId: string) => {
    setDatasourceBrowsingId(connectionId)
    try {
      const result = await galaxyBrainAPI.getDatasourceItems(connectionId)
      if (!result) throw new Error("Item listing failed")
      setDatasourceItemsByConnection((prev) => ({ ...prev, [connectionId]: result.items }))
      toast({ title: "Datasource items loaded", description: `${result.count} item(s) ready to import.` })
    } catch {
      toast({ title: "Browse failed", description: "Could not list datasource items.", variant: "destructive" })
    } finally {
      setDatasourceBrowsingId(null)
    }
  }

  const handleImportDatasourceItem = async (connection: DatasourceConnection, itemId: string) => {
    if (!currentWorkspace) {
      toast({ title: "No workspace selected", description: "Open a workspace before importing datasource items.", variant: "destructive" })
      return
    }
    const existingNodeId = getImportedDatasourceNodeId(connection.id, itemId)
    if (existingNodeId) {
      toast({
        title: "Already imported",
        description: "This datasource item is already in your workspace.",
      })
      return
    }
    setDatasourceImportingId(`${connection.id}:${itemId}`)
    try {
      const result = await galaxyBrainAPI.importDatasourceItems(connection.id, [itemId])
      const imported = result?.items?.[0]
      if (!imported) throw new Error("Import failed")
      const kind = detectDatasourceNodeKind(imported)
      const node = galaxyBrainService.createNode(
        kind.type,
        imported.title,
        imported.content,
        kind.category,
        currentWorkspace.id,
      )
      galaxyBrainService.updateNode(node.id, {
        metadata: {
          ...node.metadata,
          sourceType: "datasource",
          mimeType: imported.mime_type || undefined,
          datasourceId: connection.id,
          datasourcePluginId: connection.plugin_id,
          datasourceDisplayName: connection.display_name,
          datasourceItemId: imported.id,
          datasourcePath: imported.path,
          datasourceImportedAt: new Date().toISOString(),
          datasourceContentFingerprint: getDatasourceContentFingerprint(imported.title, imported.content),
          datasourceWarnings: imported.warnings || [],
          datasourceRefreshEvents: [
            {
              refreshedAt: new Date().toISOString(),
              strategy: "import",
              sourcePath: imported.path || "",
              sourceUpdatedAt: imported.updated_at || null,
              hadConflict: false,
            },
          ],
        },
      })
      contentProcessingService.enqueueNode(node.id)
      toast({ title: "Datasource item imported", description: imported.path || imported.title })
    } catch {
      toast({ title: "Import failed", description: "Could not import the datasource item.", variant: "destructive" })
    } finally {
      setDatasourceImportingId(null)
    }
  }

  const handleCreateDatasource = async () => {
    if (!connectionName.trim()) {
      toast({ title: "Name required", description: "Add a datasource name before connecting.", variant: "destructive" })
      return
    }
    if (selectedPluginId === "filesystem-vault" && !connectionPath.trim()) {
      toast({ title: "Path required", description: "Choose a local vault or folder path.", variant: "destructive" })
      return
    }
    setDatasourceSaving(true)
    try {
      const result = await galaxyBrainAPI.createDatasourceConnection({
        plugin_id: selectedPluginId,
        display_name: connectionName.trim(),
        root_path: connectionPath.trim() || undefined,
        config: {},
      })
      if (!result) throw new Error("Connection creation failed")
      toast({ title: "Datasource connected", description: `${result.display_name} is ready.` })
      await refreshDatasources()
      setConnectionName("My Vault")
    } catch {
      toast({ title: "Connection failed", description: "Could not create datasource connection.", variant: "destructive" })
    } finally {
      setDatasourceSaving(false)
    }
  }

  const handleSyncDatasource = async (connectionId: string) => {
    try {
      const result = await galaxyBrainAPI.syncDatasourceConnection(connectionId)
      if (!result) throw new Error("Sync failed")
      toast({ title: "Datasource synced", description: result.message })
      await refreshDatasources()
    } catch {
      toast({ title: "Sync failed", description: "Could not scan the datasource.", variant: "destructive" })
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="settings-dialog-content app-panel max-h-[88vh] rounded-[1.75rem] border-white/60 p-0 sm:max-w-[680px] dark:border-white/10">
        <DialogHeader>
          <div className="app-hero border-b border-white/40 px-6 py-5 dark:border-white/10">
            <div className="app-chip mb-3 w-fit">Workspace Controls</div>
            <DialogTitle className="font-display text-2xl text-cosmic-900 dark:text-white">Settings</DialogTitle>
            <DialogDescription className="text-cosmic-500 dark:text-cosmic-400">Configure your Galaxy Brain workspace</DialogDescription>
          </div>
        </DialogHeader>

        {/* Tab switcher */}
        <div className="mx-6 mt-5 mb-4 flex gap-1 rounded-2xl border border-white/60 bg-white/70 p-1 shadow-sm dark:border-white/10 dark:bg-cosmic-950/60">
          <button
            className={`rounded-xl px-4 py-2 text-sm font-medium transition-colors ${
              activeTab === "general"
                ? "bg-galaxy-600 text-white"
                : "text-cosmic-500 hover:text-cosmic-900 dark:text-cosmic-400 dark:hover:text-white"
            }`}
            onClick={() => setActiveTab("general")}
          >
            General
          </button>
          <button
            className={`rounded-xl px-4 py-2 text-sm font-medium transition-colors ${
              activeTab === "tools"
                ? "bg-galaxy-600 text-white"
                : "text-cosmic-500 hover:text-cosmic-900 dark:text-cosmic-400 dark:hover:text-white"
            }`}
            onClick={() => setActiveTab("tools")}
          >
            Tool Settings
          </button>
          <button
            className={`rounded-xl px-4 py-2 text-sm font-medium transition-colors ${
              activeTab === "data"
                ? "bg-galaxy-600 text-white"
                : "text-cosmic-500 hover:text-cosmic-900 dark:text-cosmic-400 dark:hover:text-white"
            }`}
            onClick={() => setActiveTab("data")}
          >
            Data
          </button>
        </div>

        <div className="settings-dialog-body custom-scrollbar px-6 pb-6">
        {/* General tab */}
        {activeTab === "general" && (
          <div className="space-y-5">
            {/* Theme */}
            <div className="rounded-[1.25rem] border border-white/60 bg-white/70 p-4 shadow-sm dark:border-white/10 dark:bg-cosmic-950/45">
            <div className="flex items-center justify-between">
              <div>
                <Label>Theme</Label>
                <p className="text-xs text-muted-foreground">Choose your preferred appearance</p>
              </div>
              <div className="flex items-center gap-1 rounded-xl border border-white/60 bg-white/70 p-0.5 shadow-sm dark:border-white/10 dark:bg-cosmic-950/60">
                <Button
                  variant={theme === "light" ? "secondary" : "ghost"}
                  size="icon"
                  className="h-8 w-8 rounded-lg"
                  onClick={() => setTheme("light")}
                >
                  <Sun className="h-4 w-4" />
                </Button>
                <Button
                  variant={theme === "dark" ? "secondary" : "ghost"}
                  size="icon"
                  className="h-8 w-8 rounded-lg"
                  onClick={() => setTheme("dark")}
                >
                  <Moon className="h-4 w-4" />
                </Button>
                <Button
                  variant={theme === "system" ? "secondary" : "ghost"}
                  size="icon"
                  className="h-8 w-8 rounded-lg"
                  onClick={() => setTheme("system")}
                >
                  <Monitor className="h-4 w-4" />
                </Button>
              </div>
            </div>
            </div>

            {/* Default view */}
            <div className="rounded-[1.25rem] border border-white/60 bg-white/70 p-4 shadow-sm dark:border-white/10 dark:bg-cosmic-950/45">
            <div className="flex items-center justify-between">
              <div>
                <Label>Default View</Label>
                <p className="text-xs text-muted-foreground">View mode when opening the app</p>
              </div>
              <Select value={defaultView} onValueChange={setDefaultView}>
                <SelectTrigger className="w-32 rounded-xl border-white/60 bg-white/70 dark:border-white/10 dark:bg-cosmic-950/60">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="canvas">Canvas</SelectItem>
                  <SelectItem value="graph">Graph</SelectItem>
                  <SelectItem value="list">List</SelectItem>
                </SelectContent>
              </Select>
            </div>
            </div>

            {/* Auto-save */}
            <div className="rounded-[1.25rem] border border-white/60 bg-white/70 p-4 shadow-sm dark:border-white/10 dark:bg-cosmic-950/45">
            <div className="flex items-center justify-between">
              <div>
                <Label>Auto-save</Label>
                <p className="text-xs text-muted-foreground">Automatically save changes</p>
              </div>
              <Switch checked={autoSave} onCheckedChange={setAutoSave} />
            </div>
            </div>

            {/* Node preview */}
            <div className="rounded-[1.25rem] border border-white/60 bg-white/70 p-4 shadow-sm dark:border-white/10 dark:bg-cosmic-950/45">
            <div className="flex items-center justify-between">
              <div>
                <Label>Node Preview</Label>
                <p className="text-xs text-muted-foreground">Show content preview on hover</p>
              </div>
              <Switch checked={showNodePreview} onCheckedChange={setShowNodePreview} />
            </div>
            </div>
          </div>
        )}

        {/* Tools tab */}
        {activeTab === "tools" && (
          <div className="space-y-5">
            {/* Default AI model */}
            <div className="rounded-[1.25rem] border border-white/60 bg-white/70 p-4 shadow-sm dark:border-white/10 dark:bg-cosmic-950/45">
            <div className="flex items-center justify-between">
              <div>
                <Label>Default AI Model</Label>
                <p className="text-xs text-muted-foreground">Model used for AI tools</p>
              </div>
              <Select value={defaultModel} onValueChange={setDefaultModel}>
                <SelectTrigger className="w-40 rounded-xl border-white/60 bg-white/70 dark:border-white/10 dark:bg-cosmic-950/60">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="gpt-4">GPT-4</SelectItem>
                  <SelectItem value="gpt-3.5-turbo">GPT-3.5 Turbo</SelectItem>
                  <SelectItem value="claude-sonnet">Claude Sonnet</SelectItem>
                  <SelectItem value="claude-haiku">Claude Haiku</SelectItem>
                </SelectContent>
              </Select>
            </div>
            </div>

            {/* Temperature */}
            <div className="rounded-[1.25rem] border border-white/60 bg-white/70 p-4 shadow-sm dark:border-white/10 dark:bg-cosmic-950/45">
            <div className="flex items-center justify-between">
              <div>
                <Label>Default Temperature</Label>
                <p className="text-xs text-muted-foreground">Creativity level for AI responses</p>
              </div>
              <Select value={defaultTemperature} onValueChange={setDefaultTemperature}>
                <SelectTrigger className="w-32 rounded-xl border-white/60 bg-white/70 dark:border-white/10 dark:bg-cosmic-950/60">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="0">0 (Precise)</SelectItem>
                  <SelectItem value="0.3">0.3 (Low)</SelectItem>
                  <SelectItem value="0.7">0.7 (Medium)</SelectItem>
                  <SelectItem value="1.0">1.0 (High)</SelectItem>
                  <SelectItem value="1.5">1.5 (Creative)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            </div>

            {/* Auto-expand AI tools */}
            <div className="rounded-[1.25rem] border border-white/60 bg-white/70 p-4 shadow-sm dark:border-white/10 dark:bg-cosmic-950/45">
            <div className="flex items-center justify-between">
              <div>
                <Label>Auto-expand AI Tools</Label>
                <p className="text-xs text-muted-foreground">Expand AI category by default in tool panel</p>
              </div>
              <Switch checked={expandAiTools} onCheckedChange={setExpandAiTools} />
            </div>
            </div>
          </div>
        )}

        {/* Data tab */}
        {activeTab === "data" && (
          <div className="space-y-5">
            {/* Local knowledge base stats */}
            <div className="rounded-[1.25rem] border border-white/60 bg-white/70 p-4 space-y-2 shadow-sm dark:border-white/10 dark:bg-cosmic-950/45">
              <Label>Knowledge Base</Label>
              <div className="grid grid-cols-2 gap-2 text-sm">
                <span className="text-muted-foreground">Nodes:</span>
                <span>{weaviateService.getNodes().length}</span>
                <span className="text-muted-foreground">Edges:</span>
                <span>{weaviateService.getEdges().length}</span>
                <span className="text-muted-foreground">Workspaces:</span>
                <span>{weaviateService.getWorkspaces().length}</span>
              </div>
            </div>

            {/* HAM Memory Backend Stats */}
            <div className="rounded-[1.25rem] border border-white/60 bg-white/70 p-4 space-y-3 shadow-sm dark:border-white/10 dark:bg-cosmic-950/45">
              <div className="flex items-center justify-between">
                <Label>HAM Memory Backend</Label>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={() => {
                    setStatsLoading(true)
                    Promise.allSettled([weaviateService.hamStats(), weaviateService.hamFieldStats()])
                      .then(([sr, fr]) => {
                        if (sr.status === "fulfilled") setHamStats(sr.value)
                        if (fr.status === "fulfilled") setFieldStats(fr.value)
                      })
                      .finally(() => setStatsLoading(false))
                  }}
                >
                  {statsLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                </Button>
              </div>
              {hamStats ? (
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <span className="text-muted-foreground">Total memories:</span>
                  <span>{hamStats.total ?? "—"}</span>
                  <span className="text-muted-foreground">Tier 1 (recent):</span>
                  <span>{hamStats.tier1 ?? "—"}</span>
                  <span className="text-muted-foreground">Tier 2 (episodic):</span>
                  <span>{hamStats.tier2 ?? "—"}</span>
                  <span className="text-muted-foreground">Tier 3 (archival):</span>
                  <span>{hamStats.tier3 ?? "—"}</span>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">{statsLoading ? "Loading..." : "HAM server not reachable"}</p>
              )}
              {fieldStats && (
                <div className="grid grid-cols-2 gap-2 text-sm pt-2 border-t">
                  <span className="text-muted-foreground">BitNet enrichment:</span>
                  <span>{fieldStats.enrichment?.enabled ? "Enabled" : "Disabled"}</span>
                  {fieldStats.enrichment?.enabled && (
                    <>
                      <span className="text-muted-foreground">Queue depth:</span>
                      <span>{fieldStats.enrichment?.queue_depth ?? 0}</span>
                      <span className="text-muted-foreground">Worker alive:</span>
                      <span>{fieldStats.enrichment?.worker_alive ? "Yes" : "No"}</span>
                    </>
                  )}
                </div>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={handleConsolidate}
                disabled={consolidating}
                className="w-full"
              >
                {consolidating ? <Loader2 className="h-3 w-3 animate-spin mr-2" /> : null}
                Consolidate Memory Tiers
              </Button>
            </div>

            {/* Datasource plugins */}
            <div className="rounded-[1.25rem] border border-white/60 bg-white/70 p-4 space-y-3 shadow-sm dark:border-white/10 dark:bg-cosmic-950/45">
              <div className="flex items-center justify-between">
                <div>
                  <Label>Datasource Plugins</Label>
                  <p className="text-xs text-muted-foreground">
                    Connect external folders and future datasources through a shared plugin contract.
                  </p>
                </div>
                <Button variant="ghost" size="icon" className="h-7 w-7" onClick={refreshDatasources}>
                  {datasourceLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                </Button>
              </div>

              <div className="space-y-3">
                <div className="space-y-1">
                  <Label htmlFor="datasource-plugin">Plugin</Label>
                  <Select value={selectedPluginId} onValueChange={setSelectedPluginId}>
                  <SelectTrigger id="datasource-plugin" className="rounded-xl border-white/60 bg-white/70 dark:border-white/10 dark:bg-cosmic-950/60">
                      <SelectValue placeholder="Choose a datasource plugin" />
                    </SelectTrigger>
                    <SelectContent>
                      {datasourcePlugins.map((plugin) => (
                        <SelectItem key={plugin.id} value={plugin.id}>
                          {plugin.display_name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1">
                  <Label htmlFor="datasource-name">Connection Name</Label>
                  <Input id="datasource-name" className="rounded-xl border-white/60 bg-white/70 dark:border-white/10 dark:bg-cosmic-950/60" value={connectionName} onChange={(e) => setConnectionName(e.target.value)} />
                </div>

                <div className="space-y-1">
                  <Label htmlFor="datasource-path">Vault / Folder Path</Label>
                  <Input
                    id="datasource-path"
                    className="rounded-xl border-white/60 bg-white/70 dark:border-white/10 dark:bg-cosmic-950/60"
                    placeholder="C:\\Users\\lisam\\Documents\\Vault"
                    value={connectionPath}
                    onChange={(e) => setConnectionPath(e.target.value)}
                  />
                </div>

                <Button size="sm" className="rounded-xl" onClick={handleCreateDatasource} disabled={datasourceSaving}>
                  {datasourceSaving ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                  Connect Datasource
                </Button>
              </div>

              <div className="space-y-2 pt-2 border-t">
                <Label>Connected Datasources</Label>
                {datasourceConnections.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No datasource connections yet.</p>
                ) : (
                  datasourceConnections.map((connection) => (
                    <div key={connection.id} className="rounded-xl border border-white/60 bg-white/70 p-3 space-y-2 dark:border-white/10 dark:bg-cosmic-950/45">
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-sm font-medium truncate">{connection.display_name}</p>
                          <p className="text-xs text-muted-foreground truncate">
                            {connection.plugin_display_name || connection.plugin_id}
                            {connection.root_path ? ` • ${connection.root_path}` : ""}
                          </p>
                        </div>
                        <div className="flex items-center gap-2">
                          <Button variant="outline" size="sm" className="rounded-xl border-white/60 bg-white/70 dark:border-white/10 dark:bg-cosmic-950/60" onClick={() => handleBrowseDatasource(connection.id)}>
                            {datasourceBrowsingId === connection.id ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                            Browse
                          </Button>
                          <Button variant="outline" size="sm" className="rounded-xl border-white/60 bg-white/70 dark:border-white/10 dark:bg-cosmic-950/60" onClick={() => handleSyncDatasource(connection.id)}>
                            Sync
                          </Button>
                        </div>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Status: {connection.status}
                        {connection.last_synced_at ? ` • Last sync ${new Date(connection.last_synced_at).toLocaleString()}` : " • Never synced"}
                      </p>
                      {datasourceItemsByConnection[connection.id]?.length ? (
                        <div className="space-y-2 border-t pt-2">
                          <p className="text-xs text-muted-foreground">
                            Showing {datasourceItemsByConnection[connection.id].length} item(s) from this datasource.
                          </p>
                          <div className="custom-scrollbar max-h-56 overflow-y-auto space-y-2 pr-1">
                            {datasourceItemsByConnection[connection.id].map((item) => (
                              <div key={item.id} className="rounded-xl border border-white/60 bg-white/70 px-2 py-2 text-xs dark:border-white/10 dark:bg-cosmic-950/55">
                                <div className="flex items-start justify-between gap-3">
                                  <div className="min-w-0">
                                    <p className="font-medium truncate">{item.title}</p>
                                    <p className="text-muted-foreground truncate">{item.path || item.id}</p>
                                  </div>
                                  {getImportedDatasourceNodeId(connection.id, item.id) ? (
                                    <span className="rounded-full bg-emerald-100 px-2 py-1 text-[10px] font-medium text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
                                      Imported
                                    </span>
                                  ) : null}
                                  <Button
                                    size="sm"
                                    variant="secondary"
                                    className="h-7 rounded-xl"
                                    onClick={() => handleImportDatasourceItem(connection, item.id)}
                                    disabled={datasourceImportingId === `${connection.id}:${item.id}` || !!getImportedDatasourceNodeId(connection.id, item.id)}
                                  >
                                    {datasourceImportingId === `${connection.id}:${item.id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-2" /> : null}
                                    {getImportedDatasourceNodeId(connection.id, item.id) ? "Imported" : "Import"}
                                  </Button>
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      ) : null}
                    </div>
                  ))
                )}
              </div>
            </div>

            {/* Reset HAM backend */}
            <div className="rounded-[1.25rem] border border-destructive/30 bg-white/70 p-4 space-y-3 shadow-sm dark:bg-cosmic-950/45">
              <div>
                <Label className="text-destructive">Reset HAM Database</Label>
                <p className="text-xs text-muted-foreground">
                  Delete all memories from the HAM PostgreSQL database. Local nodes are not affected.
                </p>
              </div>
              <Button variant="destructive" size="sm" onClick={handleResetHAM} disabled={resettingHAM}>
                {resettingHAM ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Trash2 className="h-4 w-4 mr-2" />}
                {resettingHAM ? "Resetting…" : confirmResetHAM ? "Click again to confirm" : "Reset HAM Database"}
              </Button>
            </div>

            {/* Clear all local data */}
            <div className="rounded-[1.25rem] border border-destructive/30 bg-white/70 p-4 space-y-3 shadow-sm dark:bg-cosmic-950/45">
              <div>
                <Label className="text-destructive">Clear All Data</Label>
                <p className="text-xs text-muted-foreground">
                  Permanently delete all notes, documents, workflows, and settings. This cannot be undone.
                </p>
              </div>
              <Button
                variant="destructive"
                size="sm"
                onClick={handleClearData}
              >
                <Trash2 className="h-4 w-4 mr-2" />
                {confirmClear ? "Click again to confirm" : "Clear All Data"}
              </Button>
            </div>
          </div>
        )}

        </div>
        <DialogFooter className="border-t border-white/40 px-6 py-4 dark:border-white/10">
          <Button variant="outline" className="rounded-xl border-white/60 bg-white/70 shadow-sm hover:bg-white dark:border-white/10 dark:bg-cosmic-950/60" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button className="rounded-xl" onClick={handleSave}>Save Changes</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
