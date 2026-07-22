import type { Prisma, PrismaClient, TagRuleSource } from "@prisma/client";
import { DEFAULT_TAG_RULES } from "../lib/tags/rules/defaults.js";
import type { TagRuleInput } from "../lib/tags/rules/evaluateRules.js";

export type TagRuleCreateData = {
  name: string;
  source: TagRuleSource;
  matcher: Record<string, unknown>;
  tagTemplate: string;
  priority?: number;
  enabled?: boolean;
};

export type TagRuleUpdateData = Partial<TagRuleCreateData>;

export class TagRuleRepository {
  constructor (private readonly prisma: PrismaClient) {}

  /** All of a user's rules, in evaluation order. */
  async list (userId: string) {
    return this.prisma.tagRule.findMany({
      where: { userId },
      orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
    });
  }

  /** Enabled rules in the plain shape evaluateRules() consumes. */
  async listEnabled (userId: string): Promise<TagRuleInput[]> {
    const rows = await this.prisma.tagRule.findMany({
      where: { userId, enabled: true },
      orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
      select: { source: true, matcher: true, tagTemplate: true, priority: true, enabled: true },
    });
    return rows.map(r => ({
      source: r.source,
      matcher: r.matcher,
      tagTemplate: r.tagTemplate,
      priority: r.priority,
      enabled: r.enabled,
    }));
  }

  async findById (userId: string, id: string) {
    return this.prisma.tagRule.findFirst({ where: { id, userId } });
  }

  async create (userId: string, data: TagRuleCreateData) {
    return this.prisma.tagRule.create({
      data: {
        userId,
        name: data.name,
        source: data.source,
        matcher: data.matcher as Prisma.InputJsonValue,
        tagTemplate: data.tagTemplate,
        priority: data.priority ?? 0,
        enabled: data.enabled ?? true,
      },
    });
  }

  /** Update a rule the user owns. Returns the updated row, or null if not found. */
  async update (userId: string, id: string, data: TagRuleUpdateData) {
    const { count } = await this.prisma.tagRule.updateMany({
      where: { id, userId },
      data: {
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.source !== undefined ? { source: data.source } : {}),
        ...(data.matcher !== undefined ? { matcher: data.matcher as Prisma.InputJsonValue } : {}),
        ...(data.tagTemplate !== undefined ? { tagTemplate: data.tagTemplate } : {}),
        ...(data.priority !== undefined ? { priority: data.priority } : {}),
        ...(data.enabled !== undefined ? { enabled: data.enabled } : {}),
      },
    });
    if (count === 0) return null;
    return this.findById(userId, id);
  }

  /** Delete a rule the user owns. Returns true when a row was removed. */
  async remove (userId: string, id: string): Promise<boolean> {
    const { count } = await this.prisma.tagRule.deleteMany({ where: { id, userId } });
    return count > 0;
  }

  /** Create the default rule set for a new user (mirrors the migration seed). */
  async seedDefaults (userId: string): Promise<void> {
    await this.prisma.tagRule.createMany({
      data: DEFAULT_TAG_RULES.map(rule => ({
        userId,
        name: rule.name,
        source: rule.source,
        matcher: rule.matcher as Prisma.InputJsonValue,
        tagTemplate: rule.tagTemplate,
        priority: rule.priority,
      })),
    });
  }
}
