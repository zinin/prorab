import { z } from "zod";
import { ReviewerSchema } from "../types.js";
import type { Reviewer } from "../types.js";

export function getReviewerId(reviewer: Reviewer): string {
  const model = reviewer.model || "default";
  const parts = [reviewer.agent, model];
  if (reviewer.variant) parts.push(reviewer.variant);
  const raw = parts.join("-");
  // Check path traversal BEFORE sanitization (replace turns ".." into "--")
  if (raw.includes("..")) {
    throw new Error(`Invalid reviewerId: "${raw}" contains path traversal`);
  }
  // Whitelist: keep only alphanumeric, dash, underscore; replace everything else
  return raw.replace(/[^a-zA-Z0-9_-]/g, "-");
}

export const ReviewersArraySchema = z.array(ReviewerSchema)
  .max(10, "Maximum 10 reviewers allowed")
  .optional()
  .superRefine((arr, ctx) => {
    if (!arr || arr.length === 0) return;
    const ids: string[] = [];
    for (const r of arr) {
      try {
        ids.push(getReviewerId(r));
      } catch (e) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: e instanceof Error ? e.message : String(e),
        });
        return;
      }
    }
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Duplicate reviewers detected",
      });
    }
  });

export function parseReviewerSpec(spec: string): Reviewer {
  const firstColon = spec.indexOf(":");
  if (firstColon === -1) {
    throw new Error(`Invalid reviewer spec "${spec}": expected "agent:model[:variant]"`);
  }
  const agent = spec.slice(0, firstColon);
  const rest = spec.slice(firstColon + 1);

  let model: string;
  let variant: string | undefined;

  // Split on last colon: model may contain colons, variant never does
  const lastColon = rest.lastIndexOf(":");
  if (lastColon === -1) {
    model = rest;
  } else {
    model = rest.slice(0, lastColon);
    variant = rest.slice(lastColon + 1);
  }

  const result = ReviewerSchema.safeParse({ agent, model, variant });
  if (!result.success) {
    throw new Error(`Invalid reviewer spec "${spec}": ${result.error.issues.map(i => i.message).join(", ")}`);
  }
  return result.data;
}
