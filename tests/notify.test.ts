import { describe, it, afterEach, mock } from "bun:test"
import { expect } from "bun:test"
import fs from "fs"
import type { OpenCodeEvent, SessionInfo } from "@opencode/client"
import type { Context } from "@opencode/plugin/tui/context"

const writeSpy = mock(() => {})
mock.module("fs", () => ({
  ...fs,
  writeFileSync: writeSpy,
}))

const { warpNotify } = await import("../src/notify")
const { default: plugin } = await import("../src/index")
const { WarpPlugin } = await import("../src/v1")
const { default: tui } = await import("../src/tui")
const { PLUGIN_VERSION } = await import("../src/version")

describe("warpNotify", () => {
  const originalVersion = process.env.WARP_CLI_AGENT_PROTOCOL_VERSION

  afterEach(() => {
    writeSpy.mockClear()
    if (originalVersion === undefined) {
      delete process.env.WARP_CLI_AGENT_PROTOCOL_VERSION
    } else {
      process.env.WARP_CLI_AGENT_PROTOCOL_VERSION = originalVersion
    }
  })

  it("skips when WARP_CLI_AGENT_PROTOCOL_VERSION is not set", () => {
    delete process.env.WARP_CLI_AGENT_PROTOCOL_VERSION
    warpNotify("title", "body")
    expect(writeSpy).not.toHaveBeenCalled()
  })

  it("writes OSC 777 sequence when Warp declares protocol support", () => {
    process.env.WARP_CLI_AGENT_PROTOCOL_VERSION = "1"
    warpNotify("warp://cli-agent", '{"event":"stop"}')
    expect(writeSpy).toHaveBeenCalledTimes(1)

    const [path, data] = writeSpy.mock.calls[0] as [string, string]
    expect(path).toBe("/dev/tty")
    expect(data).toContain("warp://cli-agent")
    expect(data).toContain('{"event":"stop"}')
    expect(data).toMatch(/^\x1b\]777;notify;/)
    expect(data).toMatch(/\x07$/)
  })
})

describe("OpenCode V2 plugin", () => {
  const originalVersion = process.env.WARP_CLI_AGENT_PROTOCOL_VERSION
  const session = {
    id: "s1",
    location: { directory: "/project" },
  } as SessionInfo

  afterEach(() => {
    writeSpy.mockClear()
    if (originalVersion === undefined)
      delete process.env.WARP_CLI_AGENT_PROTOCOL_VERSION
    else process.env.WARP_CLI_AGENT_PROTOCOL_VERSION = originalVersion
  })

  function harness(
    options: {
      parentID?: string
      cached?: boolean
      failHistory?: boolean
      failSession?: boolean
    } = {},
  ) {
    process.env.WARP_CLI_AGENT_PROTOCOL_VERSION = "1"
    let listener: ((event: { details: OpenCodeEvent }) => void) | undefined
    const current = { ...session, parentID: options.parentID }
    const unsubscribe = mock(() => {})
    const get = mock(async () => {
      if (options.failSession) throw new Error("Session unavailable")
      return current
    })
    const context = mock(async () => {
      if (options.failHistory) throw new Error("History unavailable")
      return [
        { type: "user", text: "Old query" },
        { type: "user", text: "Latest query" },
        {
          type: "assistant",
          content: [{ type: "reasoning", text: "private" }],
        },
        {
          type: "assistant",
          content: [{ type: "text", text: "Latest response" }],
        },
      ]
    })
    const ctx = {
      location: { directory: "/project" },
      client: { session: { get, context } },
      data: {
        listen: mock((callback: typeof listener) => {
          listener = callback
          return unsubscribe
        }),
        session: {
          get: () => (options.cached === false ? undefined : current),
          message: { get: () => undefined },
        },
      },
    } as unknown as Context
    const cleanup = tui.setup(ctx)
    async function emit(type: string, data: object, directory = "/project") {
      listener?.({
        details: { type, data, location: { directory } } as OpenCodeEvent,
      })
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    function payloads() {
      return writeSpy.mock.calls.map((call) => {
        const sequence = (call as unknown as [string, string])[1]
        return JSON.parse(sequence.slice(sequence.indexOf(";{") + 1, -1))
      })
    }
    return { emit, payloads, cleanup, unsubscribe, get, ctx }
  }

  it("exposes a valid V2 definition and the V1 server entrypoint", () => {
    expect(plugin.id).toBe("opencode-warp")
    expect(typeof plugin.setup).toBe("function")
    expect(plugin.server).toBe(WarpPlugin)
    expect(tui.id).toBe("opencode-warp.cli")
    expect(PLUGIN_VERSION).toBe(require("../package.json").version)
  })

  it("does not subscribe outside a supported Warp terminal", () => {
    const h = harness()
    h.cleanup?.()
    delete process.env.WARP_CLI_AGENT_PROTOCOL_VERSION
    expect(tui.setup(h.ctx)).toBeUndefined()
    expect(h.ctx.data.listen).toHaveBeenCalledTimes(1)
  })

  it("preserves the V1 prompt and tool hooks", async () => {
    process.env.WARP_CLI_AGENT_PROTOCOL_VERSION = "1"
    const hooks = await plugin.server({
      directory: "/project",
      client: {
        app: { log: async () => {} },
        session: { get: async () => ({ data: { id: "s1" } }) },
      },
    } as unknown as Parameters<typeof WarpPlugin>[0])
    await hooks["chat.message"]?.({ sessionID: "s1" }, {
      parts: [{ type: "text", text: "Legacy prompt" }],
    } as never)
    await hooks["tool.execute.before"]?.(
      { tool: "question", sessionID: "s1", callID: "t1" },
      { args: {} },
    )
    expect(writeSpy.mock.calls).toHaveLength(2)
    expect(
      (writeSpy.mock.calls[0] as unknown as [string, string])[1],
    ).toContain("prompt_submit")
    expect(
      (writeSpy.mock.calls[1] as unknown as [string, string])[1],
    ).toContain("question_asked")
  })

  it("reports session start with the plugin version and session directory", async () => {
    const h = harness()
    await h.emit("session.created", { sessionID: "s1" })
    expect(h.payloads()[0]).toMatchObject({
      event: "session_start",
      plugin_version: PLUGIN_VERSION,
      session_id: "s1",
      cwd: "/project",
    })
  })

  it("notifies only admitted user prompts, not synthetic or repeated message updates", async () => {
    const h = harness()
    await h.emit("session.inbox.enqueued", {
      sessionID: "s1",
      item: { type: "user", payload: { text: "hello" } },
    })
    await h.emit("session.inbox.enqueued", {
      sessionID: "s1",
      item: { type: "synthetic", payload: { text: "internal" } },
    })
    await h.emit("session.text.delta", { sessionID: "s1", text: "hello" })
    expect(h.payloads()).toHaveLength(1)
    expect(h.payloads()[0]).toMatchObject({
      event: "prompt_submit",
      query: "hello",
    })
  })

  it("extracts the latest prompt and assistant text on completion", async () => {
    const h = harness()
    await h.emit("session.execution.succeeded", { sessionID: "s1" })
    expect(h.payloads()[0]).toMatchObject({
      event: "stop",
      query: "Latest query",
      response: "Latest response",
    })
  })

  it("still notifies after failure or unavailable history", async () => {
    const h = harness({ failHistory: true })
    await h.emit("session.execution.failed", { sessionID: "s1" })
    expect(h.payloads()[0]).toMatchObject({
      event: "stop",
      query: "",
      response: "",
    })
  })

  it("resets status on user interruption, but not a superseded execution", async () => {
    const h = harness()
    await h.emit("session.execution.interrupted", {
      sessionID: "s1",
      reason: "superseded",
    })
    await h.emit("session.execution.interrupted", {
      sessionID: "s1",
      reason: "user",
    })
    expect(h.payloads()).toHaveLength(1)
    expect(h.payloads()[0].event).toBe("stop")
  })

  it("maps V2 permissions and ignores rejected replies", async () => {
    const h = harness()
    await h.emit("permission.asked", {
      sessionID: "s1",
      action: "shell",
      resources: ["git status"],
      metadata: { command: "git status" },
    })
    await h.emit("permission.replied", { sessionID: "s1", reply: "reject" })
    await h.emit("permission.replied", { sessionID: "s1", reply: "once" })
    expect(h.payloads()).toHaveLength(2)
    expect(h.payloads()[0]).toMatchObject({
      event: "permission_request",
      tool_name: "shell",
      summary: "Wants to run shell: git status",
    })
    expect(h.payloads()[1].event).toBe("permission_replied")
  })

  it("maps forms to questions needing user input", async () => {
    const h = harness()
    await h.emit("form.created", { form: { sessionID: "s1", title: "Choose" } })
    expect(h.payloads()[0]).toMatchObject({
      event: "question_asked",
      tool_name: "question",
    })
  })

  it("emits one completion per tool and retains its V2 name", async () => {
    const h = harness()
    const data = {
      sessionID: "s1",
      assistantMessageID: "m1",
      id: "t1",
      name: "shell",
    }
    await h.emit("session.tool.input.started", data)
    await h.emit("session.tool.success", data)
    await h.emit("session.tool.success", data)
    expect(h.payloads()).toHaveLength(1)
    expect(h.payloads()[0]).toMatchObject({
      event: "tool_complete",
      tool_name: "shell",
    })
  })

  it("suppresses subagent notifications", async () => {
    const h = harness({ parentID: "parent" })
    await h.emit("session.created", { sessionID: "s1", parentID: "parent" })
    await h.emit("permission.asked", {
      sessionID: "s1",
      action: "shell",
      resources: [],
    })
    await h.emit("session.execution.succeeded", { sessionID: "s1" })
    expect(h.payloads()).toEqual([])
  })

  it("ignores other locations and unrelated events", async () => {
    const h = harness()
    await h.emit("session.created", { sessionID: "s1" }, "/other-project")
    await h.emit("model.updated", {})
    expect(h.payloads()).toEqual([])
  })

  it("fetches and caches uncached session metadata", async () => {
    const h = harness({ cached: false })
    await h.emit("session.created", { sessionID: "s1" })
    await h.emit("form.created", { form: { sessionID: "s1" } })
    expect(h.get).toHaveBeenCalledTimes(1)
    expect(h.payloads()).toHaveLength(2)
  })

  it("skips unknown sessions rather than leaking subagent notifications", async () => {
    const h = harness({ cached: false, failSession: true })
    await h.emit("session.created", { sessionID: "s1" })
    expect(h.payloads()).toEqual([])
  })

  it("does not emit a late completion after cleanup during a history fetch", async () => {
    const h = harness()
    let resolveHistory: ((messages: []) => void) | undefined
    let historyStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      historyStarted = resolve
    })
    h.ctx.client.session.context = () =>
      new Promise((resolve) => {
        resolveHistory = resolve
        historyStarted?.()
      })
    const event = h.emit("session.execution.succeeded", { sessionID: "s1" })
    await started
    h.cleanup?.()
    resolveHistory?.([])
    await event
    expect(h.payloads()).toEqual([])
  })

  it("unsubscribes and prevents queued notifications after cleanup", async () => {
    const h = harness()
    const event = h.emit("session.created", { sessionID: "s1" })
    h.cleanup?.()
    await event
    expect(h.unsubscribe).toHaveBeenCalledTimes(1)
    expect(h.payloads()).toEqual([])
  })

  it("preserves completion/prompt order during asynchronous history reads", async () => {
    const h = harness({ cached: false })
    await Promise.all([
      h.emit("session.execution.succeeded", { sessionID: "s1" }),
      h.emit("session.inbox.enqueued", {
        sessionID: "s1",
        item: { type: "user", payload: { text: "next" } },
      }),
    ])
    expect(h.payloads().map((payload) => payload.event)).toEqual([
      "stop",
      "prompt_submit",
    ])
  })
})
