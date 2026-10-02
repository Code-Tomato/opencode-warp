import type { Plugin } from "@opencode/plugin"
import { WarpPlugin } from "./v1.js"

// OSC notifications belong to the CLI process, not the V2 background service.
export default {
  id: "opencode-warp",
  setup() {},
  server: WarpPlugin,
} satisfies Plugin.Plugin & { server: typeof WarpPlugin }
