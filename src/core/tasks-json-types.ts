import { z } from "zod";

// --- Enums ---

export const FullTaskStatusSchema = z.enum([
  "pending",
  "in-progress",
  "done",
  "review",
  "blocked",
  "rework",
  "closed",
]);

export const SubtaskStatusSchema = z.enum([
  "pending",
  "in-progress",
  "done",
  "blocked",
]);

export const TaskPrioritySchema = z.enum(["low", "medium", "high", "critical"]);

export const TaskCategorySchema = z.enum([
  "research",
  "design",
  "development",
  "testing",
  "documentation",
  "review",
]);

// --- Nested types ---

const RelevantFileSchema = z.object({
  path: z.string(),
  description: z.string(),
  action: z.enum(["create", "modify", "reference"]),
}).passthrough();

const ExistingInfrastructureSchema = z.object({
  name: z.string(),
  location: z.string(),
  usage: z.string(),
}).passthrough();

const ScopeBoundariesSchema = z.object({
  included: z.string(),
  excluded: z.string(),
}).passthrough();

// --- Subtask ---

export const FullSubtaskSchema = z.object({
  id: z.union([z.number(), z.string()]),
  parentId: z.string().optional(),
  title: z.string(),
  description: z.string().optional(),
  status: SubtaskStatusSchema,
  priority: TaskPrioritySchema.optional(),
  dependencies: z.array(z.union([z.number(), z.string()])).default([]),
  details: z.string().optional(),
  testStrategy: z.string().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  effort: z.number().optional(),
  actualEffort: z.number().optional(),
  tags: z.array(z.string()).optional(),
  assignee: z.string().optional(),
  databaseId: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  // Complexity fields
  complexity: z.union([z.string(), z.number()]).optional(),
  recommendedSubtasks: z.number().optional(),
  expansionPrompt: z.string().optional(),
  complexityReasoning: z.string().optional(),
  // AI context fields
  relevantFiles: z.array(RelevantFileSchema).optional(),
  codebasePatterns: z.array(z.string()).optional(),
  existingInfrastructure: z.array(ExistingInfrastructureSchema).optional(),
  scopeBoundaries: ScopeBoundariesSchema.optional(),
  implementationApproach: z.string().optional(),
  technicalConstraints: z.array(z.string()).optional(),
  acceptanceCriteria: z.array(z.string()).optional(),
  skills: z.array(z.string()).optional(),
  category: TaskCategorySchema.optional(),
}).passthrough();

export type FullSubtask = z.infer<typeof FullSubtaskSchema>;

// --- Task ---

export const FullTaskSchema = z.object({
  id: z.union([z.number(), z.string()]),
  title: z.string(),
  description: z.string().optional(),
  status: FullTaskStatusSchema,
  priority: TaskPrioritySchema.optional(),
  dependencies: z.array(z.union([z.number(), z.string()])).default([]),
  details: z.string().optional(),
  testStrategy: z.string().optional(),
  subtasks: z.array(FullSubtaskSchema).default([]),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  effort: z.number().optional(),
  actualEffort: z.number().optional(),
  tags: z.array(z.string()).optional(),
  assignee: z.string().optional(),
  databaseId: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  // Complexity fields
  complexity: z.union([z.string(), z.number()]).optional(),
  recommendedSubtasks: z.number().optional(),
  expansionPrompt: z.string().optional(),
  complexityReasoning: z.string().optional(),
  // AI context fields
  relevantFiles: z.array(RelevantFileSchema).optional(),
  codebasePatterns: z.array(z.string()).optional(),
  existingInfrastructure: z.array(ExistingInfrastructureSchema).optional(),
  scopeBoundaries: ScopeBoundariesSchema.optional(),
  implementationApproach: z.string().optional(),
  technicalConstraints: z.array(z.string()).optional(),
  acceptanceCriteria: z.array(z.string()).optional(),
  skills: z.array(z.string()).optional(),
  category: TaskCategorySchema.optional(),
}).passthrough();

export type FullTask = z.infer<typeof FullTaskSchema>;

// --- File metadata ---

export const FileMetadataSchema = z.object({
  version: z.string().optional(),
  lastModified: z.string().optional(),
  taskCount: z.number().optional(),
  completedCount: z.number().optional(),
  projectName: z.string().optional(),
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
  created: z.string().optional(),
  updated: z.string().optional(),
}).passthrough();

export type FileMetadata = z.infer<typeof FileMetadataSchema>;

// --- Tasks file (standard format) ---

export const TasksFileSchema = z.object({
  tasks: z.array(FullTaskSchema),
  metadata: FileMetadataSchema,
}).passthrough();

export type TasksFile = z.infer<typeof TasksFileSchema>;
