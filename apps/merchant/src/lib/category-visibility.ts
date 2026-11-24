/**
 * Showcase-only categories (categories.visibility = 'showcase') exist only to
 * feed page-builder sections such as "Offers". Shoppers never see them as
 * categories: every public route filters them out with listedCategorySql().
 *
 * Public responses are the same for everyone (they are KV-cached and shared,
 * and admin browser sessions are cached like guests), so admin screens read the
 * full list from GET /v1/admin/categories instead of getting a different
 * public response.
 *
 * Spec: docs/superpowers/specs/2026-11-23-buy-now-page-builder-design.md §4
 */
import { z } from '@hono/zod-openapi';
import type { Database } from '../db';
import { ApiError } from '../types';

export const CategoryVisibility = z
  .enum(['listed', 'showcase'])
  .openapi({ example: 'listed', description: "'showcase': used only by page-builder sections, hidden from shoppers" });
export type CategoryVisibility = z.infer<typeof CategoryVisibility>;

/** SQL condition keeping listed categories only, e.g. listedCategorySql('c') → "c.visibility = 'listed'". */
export function listedCategorySql(alias?: string): string {
  return `${alias ? `${alias}.` : ''}visibility = 'listed'`;
}

/**
 * A showcase-only category stands alone: no parent, no subcategories, and no
 * category can be placed under one. Throws 400 otherwise.
 *
 * @param id - the category being updated; omit when creating.
 */
export async function checkCategoryNesting(
  db: Database,
  next: { id?: string; visibility: CategoryVisibility; parentId: string | null },
): Promise<void> {
  if (next.visibility === 'showcase') {
    if (next.parentId) throw ApiError.badRequest("A showcase-only category can't have a parent category");
    if (next.id) {
      const [child] = await db.query<{ id: string }>(`SELECT id FROM categories WHERE parent_id = ? LIMIT 1`, [next.id]);
      if (child) throw ApiError.badRequest("A showcase-only category can't have subcategories");
    }
  }
  if (next.parentId) {
    const [parent] = await db.query<{ visibility: string }>(`SELECT visibility FROM categories WHERE id = ?`, [next.parentId]);
    if (parent?.visibility === 'showcase') {
      throw ApiError.badRequest("A category can't be placed under a showcase-only category");
    }
  }
}
