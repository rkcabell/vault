/**
 * Reads and writes the tagging rules a user has configured.
 */
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

/**
 * Stores one user's tagging rules.
 *
 * Every read and write is filtered by the owning user, so a rule id from one
 * account can never reach another account's rows.
 */
export class TagRuleRepository {
  constructor (private readonly prisma: PrismaClient) {}

  /** All of a user's rules, in evaluation order. */
  async list (userId: string) {
    return this.prisma.tagRule.findMany({
      where: { userId },
      orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
    });
  }

  /** Returns the user's enabled rules in the shape evaluateRules reads, in evaluation order. */
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

  /** Changes the fields present in `data` on a rule the user owns. Returns the updated rule, or null when the user owns no such rule. */
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

  /** True if a rule the user owns was deleted. False means the user owns no rule with that id. */
  async remove (userId: string, id: string): Promise<boolean> {
    const { count } = await this.prisma.tagRule.deleteMany({ where: { id, userId } });
    return count > 0;
  }

  /** Gives a new account the starting set of rules from DEFAULT_TAG_RULES. */
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
