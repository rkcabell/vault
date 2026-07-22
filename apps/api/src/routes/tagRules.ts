import type { FastifyPluginAsync } from "fastify";
import { z, ZodError } from "zod";
import { MATCHER_SCHEMAS, TagRuleSourceSchema, type TagRuleSource } from "@vault/types";
import { requireAuth } from "../utils/authGuard.js";
import { TagRuleRepository } from "../repositories/tagRuleRepository.js";
import { normalizeTag, TagValidationError } from "../lib/tags/normalizeTags.js";

const RuleCreateBody = z.object({
  name: z.string().min(1).max(64),
  source: TagRuleSourceSchema,
  matcher: z.record(z.unknown()).default({}),
  tagTemplate: z.string().min(1).max(64),
  priority: z.number().int().min(-1000).max(1000).default(0),
  enabled: z.boolean().default(true),
});

const RulePatchBody = RuleCreateBody.partial().refine(
  body => Object.keys(body).length > 0,
  { message: "Provide at least one field to update" },
);

/** A template must yield a valid tag once `{value}` is substituted. Returns an
 *  error message, or null when the template is fine. */
function templateError (template: string): string | null {
  const sampled = template.replaceAll("{value}", "sample");
  try {
    normalizeTag(sampled);
    return null;
  } catch (err) {
    if (err instanceof TagValidationError) return `Invalid tag template: ${err.message}`;
    throw err;
  }
}

/** Matcher must parse under the schema for its rule source. */
function matcherError (source: TagRuleSource, matcher: unknown): string | null {
  const parsed = MATCHER_SCHEMAS[source].safeParse(matcher ?? {});
  if (parsed.success) return null;
  return `Invalid matcher for ${source}: ${parsed.error.errors[0]?.message ?? "invalid shape"}`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function serialize (rule: any) {
  return {
    id: rule.id,
    name: rule.name,
    source: rule.source,
    matcher: rule.matcher ?? {},
    tagTemplate: rule.tagTemplate,
    priority: rule.priority,
    enabled: rule.enabled,
    createdAt: rule.createdAt instanceof Date ? rule.createdAt.toISOString() : rule.createdAt,
    updatedAt: rule.updatedAt instanceof Date ? rule.updatedAt.toISOString() : rule.updatedAt,
  };
}

export const tagRulesRoutes: FastifyPluginAsync = async app => {
  const repository = new TagRuleRepository(app.prisma);

  app.get("/", { preHandler: [requireAuth] }, async req => {
    const rules = await repository.list(req.userId!);
    return { rules: rules.map(serialize) };
  });

  app.post("/", { preHandler: [requireAuth] }, async (req, reply) => {
    let body: z.infer<typeof RuleCreateBody>;
    try {
      body = RuleCreateBody.parse(req.body);
    } catch (err) {
      if (err instanceof ZodError) throw app.httpErrors.badRequest(err.errors[0]?.message ?? "Invalid request body");
      throw err;
    }

    const matcherErr = matcherError(body.source, body.matcher);
    if (matcherErr) throw app.httpErrors.badRequest(matcherErr);
    const templateErr = templateError(body.tagTemplate);
    if (templateErr) throw app.httpErrors.badRequest(templateErr);

    const rule = await repository.create(req.userId!, body);
    return reply.code(201).send({ rule: serialize(rule) });
  });

  app.patch<{ Params: { id: string } }>("/:id", { preHandler: [requireAuth] }, async (req, reply) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(req.params);

    let body: z.infer<typeof RulePatchBody>;
    try {
      body = RulePatchBody.parse(req.body);
    } catch (err) {
      if (err instanceof ZodError) throw app.httpErrors.badRequest(err.errors[0]?.message ?? "Invalid request body");
      throw err;
    }

    const existing = await repository.findById(req.userId!, id);
    if (!existing) return reply.notFound();

    // Source and matcher must stay a valid pair — validate the merged result so
    // changing just one of them can't leave a matcher the new source rejects.
    const source = body.source ?? existing.source;
    const matcher = body.matcher ?? (existing.matcher as Record<string, unknown>);
    const matcherErr = matcherError(source, matcher);
    if (matcherErr) throw app.httpErrors.badRequest(matcherErr);
    if (body.tagTemplate !== undefined) {
      const templateErr = templateError(body.tagTemplate);
      if (templateErr) throw app.httpErrors.badRequest(templateErr);
    }

    const rule = await repository.update(req.userId!, id, body);
    if (!rule) return reply.notFound();
    return { rule: serialize(rule) };
  });

  app.delete<{ Params: { id: string } }>("/:id", { preHandler: [requireAuth] }, async (req, reply) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(req.params);
    const removed = await repository.remove(req.userId!, id);
    if (!removed) return reply.notFound();
    return { ok: true };
  });

  // POST /tag-rules/run?dryRun=true — retroactively apply the rules to every
  // media item (dry run previews without writing). Work happens in the
  // organize worker; poll /run/status for progress.
  app.post("/run", { preHandler: [requireAuth] }, async req => {
    const { dryRun } = z
      .object({ dryRun: z.enum(["true", "false"]).optional() })
      .parse(req.query);
    return app.mediaServices.organizeService.startRun(req.userId!, dryRun === "true");
  });

  // GET /tag-rules/run/status?jobId=... — poll organize-run progress
  app.get("/run/status", { preHandler: [requireAuth] }, async (req, reply) => {
    const { jobId } = z.object({ jobId: z.string().min(1) }).parse(req.query);
    const status = await app.mediaServices.organizeService.getStatus(req.userId!, jobId);
    if (!status) return reply.notFound();
    return status;
  });

  // GET /tag-rules/run/active — the user's in-flight run, so the UI can
  // re-attach after a reload. Returns { status: null } when nothing is running.
  app.get("/run/active", { preHandler: [requireAuth] }, async req => {
    const status = await app.mediaServices.organizeService.getActive(req.userId!);
    return { status };
  });
};
