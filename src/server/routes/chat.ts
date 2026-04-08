import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AgentTypeSchema } from "../../types.js";
import type { ChatManager } from "../chat-manager.js";
import {
  ChatSessionActiveError,
  ChatNotReadyError,
  QuestionMismatchError,
} from "../chat-manager.js";

// --- Zod schemas for Chat API endpoints ---

export const StartChatBodySchema = z
  .object({
    agent: AgentTypeSchema,
    model: z.string().optional(),
    variant: z.string().optional(),
    systemPrompt: z.string().optional(),
    userSettings: z.boolean().default(false),
    applyHooks: z.boolean().optional().default(false),
  })
  .strict();

export const MessageBodySchema = z
  .object({
    text: z.string().min(1),
  })
  .strict();

export const ReplyQuestionBodySchema = z
  .object({
    answers: z.record(z.string(), z.union([z.string(), z.array(z.string())])),
  })
  .strict();

const QuestionParamsSchema = z.object({
  id: z.string().min(1),
});

// --- Chat REST endpoints ---

// _cwd is accepted (but unused) to maintain API symmetry with executionRoutes
export function chatRoutes(chatManager: ChatManager, _cwd: string, isBatchExpandActive?: () => boolean) {
  return async function (fastify: FastifyInstance): Promise<void> {
    // POST /api/chat/start — create a new chat session (no first message sent)
    fastify.post("/api/chat/start", async (request, reply) => {
      if (isBatchExpandActive?.()) {
        return reply.code(409).send({ error: "Batch expand is active", reason: "active_session" });
      }

      const parseResult = StartChatBodySchema.safeParse(request.body ?? {});
      if (!parseResult.success) {
        return reply.code(400).send({
          error: "Invalid request body",
          details: parseResult.error.issues,
        });
      }

      const body = parseResult.data;

      try {
        await chatManager.start({
          agent: body.agent,
          model: body.model,
          variant: body.variant,
          systemPrompt: body.systemPrompt,
          userSettings: body.userSettings,
          applyHooks: body.applyHooks,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (err instanceof ChatSessionActiveError) {
          return reply.code(409).send({
            error: "Another session is active",
            reason: "active_session",
            message,
          });
        }
        return reply.code(500).send({
          error: "Failed to start chat session",
          message,
        });
      }

      const session = chatManager.getSession();
      return { started: true, sessionId: session?.id };
    });

    // POST /api/chat/message — send a user message to the active chat session
    fastify.post("/api/chat/message", async (request, reply) => {
      const parseResult = MessageBodySchema.safeParse(request.body ?? {});
      if (!parseResult.success) {
        return reply.code(400).send({
          error: "Invalid request body",
          details: parseResult.error.issues,
        });
      }

      const body = parseResult.data;

      try {
        await chatManager.sendMessage(body.text);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (err instanceof ChatNotReadyError) {
          return reply.code(400).send({
            error: "Cannot send message",
            message,
          });
        }
        return reply.code(500).send({
          error: "Internal error while sending message",
          message,
        });
      }

      return { sent: true };
    });

    // POST /api/chat/question/:id/reply — reply to a pending agent question
    fastify.post("/api/chat/question/:id/reply", async (request, reply) => {
      const paramsResult = QuestionParamsSchema.safeParse(request.params);
      if (!paramsResult.success) {
        return reply.code(400).send({
          error: "Invalid question ID parameter",
          details: paramsResult.error.issues,
        });
      }
      const { id } = paramsResult.data;

      const parseResult = ReplyQuestionBodySchema.safeParse(request.body ?? {});
      if (!parseResult.success) {
        return reply.code(400).send({
          error: "Invalid request body",
          details: parseResult.error.issues,
        });
      }

      const body = parseResult.data;

      try {
        await chatManager.replyQuestion(id, body.answers);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (err instanceof QuestionMismatchError) {
          return reply.code(400).send({
            error: "Question ID mismatch",
            message,
          });
        }
        if (err instanceof ChatNotReadyError) {
          return reply.code(400).send({
            error: "Cannot reply to question",
            message,
          });
        }
        return reply.code(500).send({
          error: "Internal error while replying to question",
          message,
        });
      }

      return { replied: true };
    });

    // DELETE /api/chat — stop the active chat session
    fastify.delete("/api/chat", async () => {
      await chatManager.stop();
      return { stopped: true };
    });

    // GET /api/chat — get current chat state and session info
    fastify.get("/api/chat", async () => {
      return {
        state: chatManager.getState(),
        session: chatManager.getSession(),
      };
    });
  };
}
