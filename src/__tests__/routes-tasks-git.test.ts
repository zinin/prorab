import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock git module
vi.mock("../core/git.js", () => ({
  commitTasksJson: vi.fn(() => true),
}));

// Mock tasks-json
vi.mock("../core/tasks-json.js", () => ({
  readTasksFile: vi.fn(() => ({
    tasks: [{ id: 1, title: "T", status: "pending", dependencies: [], subtasks: [{ id: 1, title: "S", status: "pending", dependencies: [] }] }],
    metadata: { version: "1.0.0", lastModified: "", taskCount: 1, completedCount: 0 },
  })),
  updateTask: vi.fn(() => ({
    tasks: [{ id: 1, title: "Updated", status: "done", dependencies: [], subtasks: [] }],
    metadata: { version: "1.0.0", lastModified: "", taskCount: 1, completedCount: 1 },
  })),
  updateSubtask: vi.fn(() => ({
    tasks: [{ id: 1, title: "T", status: "pending", dependencies: [], subtasks: [{ id: 1, title: "S", status: "done", dependencies: [] }] }],
    metadata: { version: "1.0.0", lastModified: "", taskCount: 1, completedCount: 0 },
  })),
  createTask: vi.fn(),
  deleteTask: vi.fn(),
  deleteSubtask: vi.fn(),
  withTasksMutex: vi.fn((fn: () => unknown) => fn()),
  TaskNotFoundError: class extends Error {},
}));

vi.mock("../server/ws.js", () => ({
  broadcastTasksUpdated: vi.fn(),
}));

import { commitTasksJson } from "../core/git.js";
import Fastify from "fastify";
import { tasksRoutes } from "../server/routes/tasks.js";

describe("task routes git commit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("PUT /api/tasks/:id calls commitTasksJson with field names", async () => {
    const app = Fastify();
    await app.register(tasksRoutes("/fake/cwd"));
    const res = await app.inject({
      method: "PUT",
      url: "/api/tasks/1",
      payload: { title: "New title", status: "done" },
    });
    expect(res.statusCode).toBe(200);
    expect(commitTasksJson).toHaveBeenCalledWith(
      "/fake/cwd",
      expect.stringContaining("task(1)"),
    );
    // Verify the commit message contains field names
    const msg = (commitTasksJson as any).mock.calls[0][1];
    expect(msg).toContain("title");
    expect(msg).toContain("status");
  });

  it("PUT /api/tasks/:taskId/subtasks/:subId calls commitTasksJson", async () => {
    const app = Fastify();
    await app.register(tasksRoutes("/fake/cwd"));
    const res = await app.inject({
      method: "PUT",
      url: "/api/tasks/1/subtasks/1",
      payload: { status: "done" },
    });
    expect(res.statusCode).toBe(200);
    expect(commitTasksJson).toHaveBeenCalledWith(
      "/fake/cwd",
      expect.stringContaining("subtask(1.1)"),
    );
  });
});
