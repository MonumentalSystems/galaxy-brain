"use client"

import { useState } from "react"
import { CalendarIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"

type ScheduledEvent = {
  id: string
  title: string
  date: Date
  flowId?: string
  status: "scheduled" | "running" | "completed" | "failed"
}

export function CalendarView() {
  const [isOpen, setIsOpen] = useState(false)
  const [date, setDate] = useState<Date | undefined>(new Date())
  const [events, setEvents] = useState<ScheduledEvent[]>([
    {
      id: "event-1",
      title: "Daily News Summary",
      date: new Date(new Date().setHours(9, 0, 0, 0)),
      flowId: "flow-123",
      status: "scheduled",
    },
    {
      id: "event-2",
      title: "Social Media Analysis",
      date: new Date(new Date().setHours(14, 30, 0, 0)),
      flowId: "flow-456",
      status: "scheduled",
    },
  ])

  // Get events for a specific date
  const getEventsForDate = (date: Date) => {
    return events.filter(
      (event) =>
        event.date.getDate() === date.getDate() &&
        event.date.getMonth() === date.getMonth() &&
        event.date.getFullYear() === date.getFullYear(),
    )
  }

  // Format time
  const formatTime = (date: Date) => {
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
  }

  return (
    <>
      <Dialog open={isOpen} onOpenChange={setIsOpen}>
        <DialogTrigger asChild>
          <Button variant="outline" size="sm">
            <CalendarIcon className="mr-2 h-4 w-4" />
            Schedule
          </Button>
        </DialogTrigger>
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>Schedule Flow Runs</DialogTitle>
            <DialogDescription>Schedule your flows to run automatically at specific times</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  variant={"outline"}
                  className={cn("w-full justify-start text-left font-normal", !date && "text-muted-foreground")}
                >
                  <CalendarIcon className="mr-2 h-4 w-4" />
                  {date ? date.toDateString() : "Pick a date"}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0">
                <Calendar mode="single" selected={date} onSelect={setDate} initialFocus />
              </PopoverContent>
            </Popover>

            {date && (
              <div className="space-y-2">
                <h4 className="text-sm font-medium">Events for {date.toDateString()}</h4>
                {getEventsForDate(date).length === 0 ? (
                  <p className="text-sm text-muted-foreground">No events scheduled</p>
                ) : (
                  <div className="space-y-2">
                    {getEventsForDate(date).map((event) => (
                      <div key={event.id} className="flex items-center justify-between rounded-md border p-2">
                        <div>
                          <p className="text-sm font-medium">{event.title}</p>
                          <p className="text-xs text-muted-foreground">{formatTime(event.date)}</p>
                        </div>
                        <div
                          className={cn(
                            "text-xs px-2 py-1 rounded-full",
                            event.status === "scheduled" && "bg-blue-100 text-blue-800",
                            event.status === "running" && "bg-yellow-100 text-yellow-800",
                            event.status === "completed" && "bg-green-100 text-green-800",
                            event.status === "failed" && "bg-red-100 text-red-800",
                          )}
                        >
                          {event.status}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setIsOpen(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
