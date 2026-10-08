export type DrawingMode = "pen" | "highlighter" | "eraser" | "text" | "select"

export type DrawingStyle = {
  color: string
  width: number
  opacity: number
}

export type DrawingPoint = {
  x: number
  y: number
  pressure?: number
}

export type DrawingStroke = {
  id: string
  points: DrawingPoint[]
  mode: DrawingMode
  style: DrawingStyle
}

export type DrawingText = {
  id: string
  x: number
  y: number
  text: string
  fontSize: number
  fontFamily: string
  color: string
}

export type DrawingElement = DrawingStroke | DrawingText

export type CanvasState = {
  elements: DrawingElement[]
  currentStroke: DrawingStroke | null
  selectedElementIds: string[]
  mode: DrawingMode
  style: DrawingStyle
}

// Canvas service for managing drawings
export class CanvasService {
  private canvasStates: Map<string, CanvasState> = new Map()
  private listeners: Map<string, Set<(state: CanvasState) => void>> = new Map()

  // Initialize canvas state for a flow
  public initCanvas(flowId: string): CanvasState {
    const initialState: CanvasState = {
      elements: [],
      currentStroke: null,
      selectedElementIds: [],
      mode: "pen",
      style: {
        color: "#000000",
        width: 2,
        opacity: 1,
      },
    }

    this.canvasStates.set(flowId, initialState)
    return initialState
  }

  // Get canvas state for a flow
  public getCanvasState(flowId: string): CanvasState {
    if (!this.canvasStates.has(flowId)) {
      return this.initCanvas(flowId)
    }
    return this.canvasStates.get(flowId)!
  }

  // Set drawing mode
  public setMode(flowId: string, mode: DrawingMode): void {
    const state = this.getCanvasState(flowId)
    state.mode = mode
    this.updateState(flowId, state)
  }

  // Set drawing style
  public setStyle(flowId: string, style: Partial<DrawingStyle>): void {
    const state = this.getCanvasState(flowId)
    state.style = { ...state.style, ...style }
    this.updateState(flowId, state)
  }

  // Start a new stroke
  public startStroke(flowId: string, point: DrawingPoint): void {
    const state = this.getCanvasState(flowId)

    if (state.mode === "select" || state.mode === "text") {
      return
    }

    const newStroke: DrawingStroke = {
      id: `stroke-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
      points: [point],
      mode: state.mode,
      style: { ...state.style },
    }

    state.currentStroke = newStroke
    this.updateState(flowId, state)
  }

  // Continue a stroke
  public continueStroke(flowId: string, point: DrawingPoint): void {
    const state = this.getCanvasState(flowId)

    if (!state.currentStroke) {
      return
    }

    state.currentStroke.points.push(point)
    this.updateState(flowId, state)
  }

  // End a stroke
  public endStroke(flowId: string): void {
    const state = this.getCanvasState(flowId)

    if (!state.currentStroke) {
      return
    }

    state.elements.push(state.currentStroke)
    state.currentStroke = null
    this.updateState(flowId, state)
  }

  // Add text
  public addText(flowId: string, x: number, y: number, text: string): void {
    const state = this.getCanvasState(flowId)

    const newText: DrawingText = {
      id: `text-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
      x,
      y,
      text,
      fontSize: 16,
      fontFamily: "Arial",
      color: state.style.color,
    }

    state.elements.push(newText)
    this.updateState(flowId, state)
  }

  // Update text
  public updateText(flowId: string, id: string, updates: Partial<Omit<DrawingText, "id">>): void {
    const state = this.getCanvasState(flowId)

    const index = state.elements.findIndex((el) => el.id === id && "text" in el)
    if (index === -1) {
      return
    }

    const text = state.elements[index] as DrawingText
    state.elements[index] = { ...text, ...updates }
    this.updateState(flowId, state)
  }

  // Select elements
  public selectElements(flowId: string, ids: string[]): void {
    const state = this.getCanvasState(flowId)
    state.selectedElementIds = ids
    this.updateState(flowId, state)
  }

  // Delete selected elements
  public deleteSelectedElements(flowId: string): void {
    const state = this.getCanvasState(flowId)

    if (state.selectedElementIds.length === 0) {
      return
    }

    state.elements = state.elements.filter((el) => !state.selectedElementIds.includes(el.id))
    state.selectedElementIds = []
    this.updateState(flowId, state)
  }

  // Clear canvas
  public clearCanvas(flowId: string): void {
    const state = this.getCanvasState(flowId)
    state.elements = []
    state.currentStroke = null
    state.selectedElementIds = []
    this.updateState(flowId, state)
  }

  // Save canvas state
  public saveCanvasState(flowId: string): CanvasState {
    return this.getCanvasState(flowId)
  }

  // Load canvas state
  public loadCanvasState(flowId: string, state: CanvasState): void {
    this.canvasStates.set(flowId, { ...state })
    this.notifyListeners(flowId)
  }

  // Subscribe to canvas state changes
  public subscribe(flowId: string, listener: (state: CanvasState) => void): () => void {
    if (!this.listeners.has(flowId)) {
      this.listeners.set(flowId, new Set())
    }

    this.listeners.get(flowId)!.add(listener)

    return () => {
      this.listeners.get(flowId)?.delete(listener)
      if (this.listeners.get(flowId)?.size === 0) {
        this.listeners.delete(flowId)
      }
    }
  }

  // Update state and notify listeners
  private updateState(flowId: string, state: CanvasState): void {
    this.canvasStates.set(flowId, { ...state })
    this.notifyListeners(flowId)
  }

  // Notify listeners of state change
  private notifyListeners(flowId: string): void {
    const state = this.getCanvasState(flowId)
    this.listeners.get(flowId)?.forEach((listener) => listener(state))
  }
}

// Export a singleton instance
export const canvasService = new CanvasService()
