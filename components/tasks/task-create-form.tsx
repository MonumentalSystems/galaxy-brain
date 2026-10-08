"use client"

import { FormEvent, useRef, useState } from "react"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import type { CreateTaskInput } from "@/lib/types/tasks"
import { createTask } from "@/lib/ham-task-client"

export type TaskCreateFormProps = {
  onCreated: () => void
}

export function TaskCreateForm({ onCreated }: TaskCreateFormProps) {
  const [values, setValues] = useState<CreateTaskInput>({
    title: "",
    goal: "",
    why: "",
    acceptanceCriteria: [],
    riskMode: "diagnostic",
    resourceKeys: [],
    resourceMode: "observe",
  })
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState("")
  const [status, setStatus] = useState("")
  const idempotencyKeyRef = useRef("")

  const complete = values.title.trim() && values.goal.trim() && values.why.trim()
  const hasResourceKeys = values.resourceKeys.some((key) => key.trim().length > 0)

  function updateDraft(update: (current: CreateTaskInput) => CreateTaskInput) {
    idempotencyKeyRef.current = ""
    setValues(update)
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!complete || submitting) {
      setError("Title, goal, and why are required before posting the task.")
      return
    }
    setSubmitting(true)
    setError("")
    setStatus("Posting task to the shared queue.")
    try {
      const idempotencyKey = idempotencyKeyRef.current || crypto.randomUUID()
      idempotencyKeyRef.current = idempotencyKey
      await createTask(values, idempotencyKey)
      idempotencyKeyRef.current = ""
      setValues({
        title: "",
        goal: "",
        why: "",
        acceptanceCriteria: [],
        riskMode: "diagnostic",
        resourceKeys: [],
        resourceMode: "observe",
      })
      setStatus("Task posted. Agents can now discover and claim it using their own identities.")
      onCreated()
    } catch (nextError) {
      setStatus("")
      setError(nextError instanceof Error ? nextError.message : "Task creation failed")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Post a task</CardTitle>
        <CardDescription>
          This creates a discoverable task. It does not assign an agent or grant execution authority.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form className="grid gap-4" onSubmit={submit} aria-describedby="task-form-help task-form-error">
          <p id="task-form-help" className="text-sm text-muted-foreground">
            Agents accept, decline, or ask for clarification through HAM with their own Nostr identities.
          </p>
          <div className="grid gap-2">
            <Label htmlFor="task-title">Title</Label>
            <Input
              id="task-title"
              value={values.title}
              maxLength={200}
              required
              onChange={(event) => updateDraft((current) => ({ ...current, title: event.target.value }))}
            />
          </div>
          <details className="rounded-lg border p-3">
            <summary className="cursor-pointer text-sm font-medium">Affected resources (optional)</summary>
            <div className="mt-4 grid gap-4">
              <div className="grid gap-2">
                <Label htmlFor="task-resources">Resource keys</Label>
                <Textarea
                  id="task-resources"
                  value={values.resourceKeys.join("\n")}
                  placeholder={"repo:your-org/your-repo\nservice:your-service\nsurface:your-surface"}
                  aria-describedby="task-resources-help"
                  onChange={(event) => updateDraft((current) => {
                    const resourceKeys = event.target.value.split(/\r?\n/)
                    return {
                      ...current,
                      resourceKeys,
                      resourceMode: resourceKeys.some((key) => key.trim().length > 0)
                        ? current.resourceMode
                        : "observe",
                    }
                  })}
                />
                <p id="task-resources-help" className="text-xs text-muted-foreground">
                  One stable key per line, up to 50. Use forms such as repo:owner/name,
                  machine:host/subsystem, or service:name. These declarations expose overlapping work;
                  they do not grant the selected access.
                </p>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="task-resource-mode">Resource intent (not permission)</Label>
                <Select
                  value={values.resourceMode}
                  disabled={!hasResourceKeys}
                  onValueChange={(value: CreateTaskInput["resourceMode"]) => updateDraft((current) => ({ ...current, resourceMode: value }))}
                >
                  <SelectTrigger id="task-resource-mode" aria-describedby="task-resource-mode-help">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="observe">Observe</SelectItem>
                    <SelectItem value="read">Read</SelectItem>
                    <SelectItem value="write">Write</SelectItem>
                    <SelectItem value="exclusive">Exclusive</SelectItem>
                  </SelectContent>
                </Select>
                <p id="task-resource-mode-help" className="text-xs text-muted-foreground">
                  {hasResourceKeys
                    ? "The executor still needs an independently authorized capability before it can act."
                    : "Enter at least one resource key to declare observe, read, write, or exclusive intent."}
                </p>
              </div>
            </div>
          </details>
          <div className="grid gap-2">
            <Label htmlFor="task-goal">Goal</Label>
            <Textarea
              id="task-goal"
              value={values.goal}
              maxLength={4000}
              required
              onChange={(event) => updateDraft((current) => ({ ...current, goal: event.target.value }))}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="task-why">Why this matters</Label>
            <Textarea
              id="task-why"
              value={values.why}
              maxLength={4000}
              required
              onChange={(event) => updateDraft((current) => ({ ...current, why: event.target.value }))}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="task-acceptance">Acceptance criteria</Label>
            <Textarea
              id="task-acceptance"
              value={values.acceptanceCriteria.join("\n")}
              placeholder={"One verifiable outcome per line\nRequired checks pass\nIndependent review is complete"}
              aria-describedby="task-acceptance-help"
              onChange={(event) => updateDraft((current) => ({
                ...current,
                acceptanceCriteria: event.target.value.split(/\r?\n/),
              }))}
            />
            <p id="task-acceptance-help" className="text-xs text-muted-foreground">
              Optional, up to 50 lines. Agents should use these outcomes when reporting completion.
            </p>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="task-risk">Activity mode</Label>
            <Select
              value={values.riskMode}
              onValueChange={(value: CreateTaskInput["riskMode"]) => updateDraft((current) => ({ ...current, riskMode: value }))}
            >
              <SelectTrigger id="task-risk" aria-describedby="task-risk-help">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="diagnostic">Diagnostic or read-only</SelectItem>
                <SelectItem value="test">Intentional test activity</SelectItem>
                <SelectItem value="production">Production-affecting intent</SelectItem>
              </SelectContent>
            </Select>
            <p id="task-risk-help" className="text-xs text-muted-foreground">
              This is visible context, not permission. Capabilities remain separately authorized.
            </p>
          </div>
          {error ? <p id="task-form-error" role="alert" className="text-sm text-destructive">{error}</p> : null}
          <p role="status" aria-live="polite" className="text-sm text-muted-foreground">{status}</p>
          <div>
            <Button type="submit" aria-disabled={!complete || submitting}>
              {submitting ? "Posting task..." : "Post task"}
            </Button>
            {!complete ? (
              <p className="mt-2 text-xs text-muted-foreground">Complete all three text fields to post.</p>
            ) : null}
          </div>
        </form>
      </CardContent>
    </Card>
  )
}
