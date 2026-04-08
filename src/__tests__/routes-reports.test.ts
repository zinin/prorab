import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../core/reporter.js", () => ({
  readReport: vi.fn(),
  readReviewReport: vi.fn(),
  readReworkReport: vi.fn(),
}));

vi.mock("../core/tasks-json.js", () => ({
  getReviewRoundInfo: vi.fn(),
}));

import { readReport, readReviewReport, readReworkReport } from "../core/reporter.js";
import { getReviewRoundInfo } from "../core/tasks-json.js";
import Fastify from "fastify";
import { reportsRoutes } from "../server/routes/reports.js";

const mockedReadReport = vi.mocked(readReport);
const mockedReadReviewReport = vi.mocked(readReviewReport);
const mockedReadReworkReport = vi.mocked(readReworkReport);
const mockedGetReviewRoundInfo = vi.mocked(getReviewRoundInfo);

describe("reports routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("GET /api/reports/:unitId returns report content", async () => {
    mockedReadReport.mockReturnValue("# Report\nAll done.");
    const app = Fastify();
    await app.register(reportsRoutes("/fake/cwd"));
    const res = await app.inject({ method: "GET", url: "/api/reports/1.3" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ unitId: "1.3", content: "# Report\nAll done." });
    expect(mockedReadReport).toHaveBeenCalledWith("/fake/cwd", "1.3");
  });

  it("GET /api/reports/:unitId returns 404 when report not found", async () => {
    mockedReadReport.mockReturnValue(null);
    const app = Fastify();
    await app.register(reportsRoutes("/fake/cwd"));
    const res = await app.inject({ method: "GET", url: "/api/reports/5" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "Report for 5 not found" });
  });

  it("GET /api/reports/:unitId returns 400 for invalid unitId", async () => {
    const app = Fastify();
    await app.register(reportsRoutes("/fake/cwd"));

    const invalid = ["../etc/passwd", "abc", "1.2.3", "", "1;rm -rf"];
    for (const id of invalid) {
      const res = await app.inject({ method: "GET", url: `/api/reports/${encodeURIComponent(id)}` });
      expect(res.statusCode).toBe(400);
    }
    expect(mockedReadReport).not.toHaveBeenCalled();
  });

  it("GET /api/reports/:unitId accepts task-only ids", async () => {
    mockedReadReport.mockReturnValue("report");
    const app = Fastify();
    await app.register(reportsRoutes("/fake/cwd"));
    const res = await app.inject({ method: "GET", url: "/api/reports/42" });
    expect(res.statusCode).toBe(200);
    expect(res.json().unitId).toBe("42");
  });
});

describe("review report routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("GET /api/reports/:taskId/review?round=N returns round-specific report", async () => {
    mockedReadReviewReport.mockReturnValue("# Round 2 review");
    const app = Fastify();
    await app.register(reportsRoutes("/fake/cwd"));
    const res = await app.inject({ method: "GET", url: "/api/reports/5/review?round=2" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ taskId: "5", round: 2, content: "# Round 2 review" });
    expect(mockedReadReviewReport).toHaveBeenCalledWith("/fake/cwd", "5", 2);
  });

  it("GET /api/reports/:taskId/review?round=N returns 404 when not found", async () => {
    mockedReadReviewReport.mockReturnValue(null);
    const app = Fastify();
    await app.register(reportsRoutes("/fake/cwd"));
    const res = await app.inject({ method: "GET", url: "/api/reports/5/review?round=3" });
    expect(res.statusCode).toBe(404);
  });

  it("GET /api/reports/:taskId/review?round=invalid returns 400", async () => {
    const app = Fastify();
    await app.register(reportsRoutes("/fake/cwd"));
    for (const round of ["abc", "0", "-1", "1.5"]) {
      const res = await app.inject({ method: "GET", url: `/api/reports/5/review?round=${round}` });
      expect(res.statusCode).toBe(400);
    }
  });

  it("GET /api/reports/:taskId/review without round returns default report", async () => {
    mockedReadReviewReport.mockReturnValue("# Default review");
    const app = Fastify();
    await app.register(reportsRoutes("/fake/cwd"));
    const res = await app.inject({ method: "GET", url: "/api/reports/5/review" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ taskId: "5", content: "# Default review" });
    // Called without round parameter
    expect(mockedReadReviewReport).toHaveBeenCalledWith("/fake/cwd", "5");
  });

  it("GET /api/reports/:taskId/review falls back to latest round when default not found", async () => {
    // No default report, but round 2 exists
    mockedReadReviewReport.mockImplementation((_cwd, _taskId, round?) => {
      if (round === undefined) return null;
      if (round === 2) return "# Round 2 review";
      return null;
    });
    mockedGetReviewRoundInfo.mockReturnValue({ reviewRoundsTotal: 3, reviewRound: 2, roundSuffix: 2 });
    const app = Fastify();
    await app.register(reportsRoutes("/fake/cwd"));
    const res = await app.inject({ method: "GET", url: "/api/reports/5/review" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ taskId: "5", round: 2, content: "# Round 2 review" });
  });

  it("GET /api/reports/:taskId/review returns 404 when task has no metadata", async () => {
    mockedReadReviewReport.mockReturnValue(null);
    mockedGetReviewRoundInfo.mockImplementation(() => { throw new Error("Task not found"); });
    const app = Fastify();
    await app.register(reportsRoutes("/fake/cwd"));
    const res = await app.inject({ method: "GET", url: "/api/reports/5/review" });
    expect(res.statusCode).toBe(404);
  });

  it("GET /api/reports/:taskId/review returns 400 for invalid taskId", async () => {
    const app = Fastify();
    await app.register(reportsRoutes("/fake/cwd"));
    const res = await app.inject({ method: "GET", url: "/api/reports/abc/review" });
    expect(res.statusCode).toBe(400);
  });
});

describe("rework report routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("GET /api/reports/:taskId/rework?round=N returns round-specific report", async () => {
    mockedReadReworkReport.mockReturnValue("# Round 1 rework");
    const app = Fastify();
    await app.register(reportsRoutes("/fake/cwd"));
    const res = await app.inject({ method: "GET", url: "/api/reports/5/rework?round=1" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ taskId: "5", round: 1, content: "# Round 1 rework" });
    expect(mockedReadReworkReport).toHaveBeenCalledWith("/fake/cwd", "5", 1);
  });

  it("GET /api/reports/:taskId/rework?round=N returns 404 when not found", async () => {
    mockedReadReworkReport.mockReturnValue(null);
    const app = Fastify();
    await app.register(reportsRoutes("/fake/cwd"));
    const res = await app.inject({ method: "GET", url: "/api/reports/5/rework?round=2" });
    expect(res.statusCode).toBe(404);
  });

  it("GET /api/reports/:taskId/rework without round returns default report", async () => {
    mockedReadReworkReport.mockReturnValue("# Default rework");
    const app = Fastify();
    await app.register(reportsRoutes("/fake/cwd"));
    const res = await app.inject({ method: "GET", url: "/api/reports/5/rework" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ taskId: "5", content: "# Default rework" });
  });

  it("GET /api/reports/:taskId/rework falls back to latest round", async () => {
    mockedReadReworkReport.mockImplementation((_cwd, _taskId, round?) => {
      if (round === undefined) return null;
      if (round === 3) return "# Round 3 rework";
      return null;
    });
    mockedGetReviewRoundInfo.mockReturnValue({ reviewRoundsTotal: 3, reviewRound: 3, roundSuffix: 3 });
    const app = Fastify();
    await app.register(reportsRoutes("/fake/cwd"));
    const res = await app.inject({ method: "GET", url: "/api/reports/5/rework" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ taskId: "5", round: 3, content: "# Round 3 rework" });
  });

  it("GET /api/reports/:taskId/rework returns 400 for invalid taskId", async () => {
    const app = Fastify();
    await app.register(reportsRoutes("/fake/cwd"));
    const res = await app.inject({ method: "GET", url: "/api/reports/abc/rework" });
    expect(res.statusCode).toBe(400);
  });
});
