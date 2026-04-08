import type { AgentDriver } from "../../core/drivers/types.js";

/** Chat method stubs shared across all AgentDriver mocks. */
export const chatStubs = {
  async *startChat() { throw new Error("not implemented"); },
  sendMessage: () => { throw new Error("not implemented"); },
  replyQuestion: () => { throw new Error("not implemented"); },
  abortChat: () => { throw new Error("not implemented"); },
} satisfies Pick<AgentDriver, "startChat" | "sendMessage" | "replyQuestion" | "abortChat">;
