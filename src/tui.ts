import type { OpenCodeEvent, SessionInfo } from "@opencode/client"
import type { Plugin } from "@opencode/plugin/tui"
import { buildPayload } from "./payload.js"
import { warpNotify } from "./notify.js"
import { extractTextFromParts, truncate } from "./utils.js"
import { PLUGIN_VERSION } from "./version.js"

export default {
  id: "opencode-warp.cli",
  setup(ctx) {
    if (!process.env.WARP_CLI_AGENT_PROTOCOL_VERSION) return

    let disposed = false
    let pending = Promise.resolve()
    const sessions = new Map<string, SessionInfo>()
    const completedTools = new Map<string, Set<string>>()
    const toolNames = new Map<string, Map<string, string>>()

    function notify(
      event: string,
      session: SessionInfo,
      fields: Record<string, unknown> = {},
    ) {
      if (disposed) return
      warpNotify(
        "warp://cli-agent",
        buildPayload(event, session.id, session.location.directory, fields),
      )
    }

    async function handle(event: OpenCodeEvent) {
      switch (event.type) {
        case "session.created":
        case "session.inbox.enqueued":
        case "session.execution.succeeded":
        case "session.execution.failed":
        case "session.execution.interrupted":
        case "permission.asked":
        case "permission.replied":
        case "form.created":
        case "session.tool.input.started":
        case "session.tool.success":
        case "session.tool.failed":
        case "session.deleted":
          break
        default:
          return
      }

      if (
        ctx.location &&
        event.location &&
        (ctx.location.directory !== event.location.directory ||
          ctx.location.workspaceID !== event.location.workspaceID)
      )
        return

      const sessionID =
        event.type === "form.created"
          ? event.data.form.sessionID
          : event.data.sessionID
      if (event.type === "session.deleted") {
        sessions.delete(sessionID)
        completedTools.delete(sessionID)
        toolNames.delete(sessionID)
        return
      }

      let session = ctx.data.session.get(sessionID) ?? sessions.get(sessionID)
      if (!session) {
        try {
          session = await ctx.client.session.get({ sessionID })
          if (session) sessions.set(sessionID, session)
        } catch {
          return
        }
      }
      if (!session || session.parentID || disposed) return
      if (ctx.location && session.location.directory !== ctx.location.directory)
        return

      switch (event.type) {
        case "session.created":
          if (!event.data.parentID)
            notify("session_start", session, { plugin_version: PLUGIN_VERSION })
          return
        case "session.inbox.enqueued":
          if (event.data.item.type === "user" && event.data.item.payload.text) {
            notify("prompt_submit", session, {
              query: truncate(event.data.item.payload.text, 200),
            })
          }
          return
        case "session.execution.succeeded":
        case "session.execution.failed":
        case "session.execution.interrupted": {
          if (
            event.type === "session.execution.interrupted" &&
            event.data.reason === "superseded"
          )
            return
          let query = ""
          let response = ""
          try {
            const result = await ctx.client.session.context({ sessionID })
            const messages = [...result].reverse()
            const user = messages.find((message) => message.type === "user")
            const assistant = messages.find(
              (message) => message.type === "assistant",
            )
            if (user?.type === "user") query = user.text
            if (assistant?.type === "assistant")
              response = extractTextFromParts(assistant.content)
          } catch {
            // Completion notifications must still work when history is unavailable.
          }
          notify("stop", session, {
            query: truncate(query, 200),
            response: truncate(response, 200),
            transcript_path: "",
          })
          return
        }
        case "permission.asked": {
          const { action, resources, metadata = {}, message } = event.data
          const preview = resources.join(", ")
          notify("permission_request", session, {
            summary: truncate(
              message ||
                `Wants to run ${action}${preview ? `: ${preview}` : ""}`,
              200,
            ),
            tool_name: action,
            tool_input: metadata,
          })
          return
        }
        case "permission.replied":
          if (event.data.reply !== "reject")
            notify("permission_replied", session)
          return
        case "form.created":
          notify("question_asked", session, { tool_name: "question" })
          return
        case "session.tool.input.started": {
          let names = toolNames.get(sessionID)
          if (!names) {
            names = new Map()
            toolNames.set(sessionID, names)
          }
          names.set(
            `${event.data.assistantMessageID}:${event.data.id}`,
            event.data.name,
          )
          return
        }
        case "session.tool.success":
        case "session.tool.failed": {
          let completed = completedTools.get(sessionID)
          if (!completed) {
            completed = new Set()
            completedTools.set(sessionID, completed)
          }
          const key = `${event.data.assistantMessageID}:${event.data.id}`
          if (completed.has(key)) return
          completed.add(key)
          const message = ctx.data.session.message.get(
            sessionID,
            event.data.assistantMessageID,
          )
          const content =
            message?.type === "assistant"
              ? message.content.find(
                  (part) => part.type === "tool" && part.id === event.data.id,
                )
              : undefined
          const name =
            toolNames.get(sessionID)?.get(key) ??
            (content?.type === "tool" ? content.name : "unknown")
          notify("tool_complete", session, { tool_name: name })
          toolNames.get(sessionID)?.delete(key)
          return
        }
      }
    }

    const unsubscribe = ctx.data.listen(({ details }) => {
      // Preserve event order even when fetching session metadata or completion history.
      pending = pending
        .then(() => (disposed ? undefined : handle(details)))
        .catch((error) => {
          console.error("[opencode-warp] failed to process CLI event:", error)
        })
    })
    return () => {
      disposed = true
      unsubscribe()
      sessions.clear()
      completedTools.clear()
      toolNames.clear()
    }
  },
} satisfies Plugin.Definition
