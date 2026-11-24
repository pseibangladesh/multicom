/**
 * Home page sections (Admin → Page builder).
 *
 *   GET    /v1/storefront/home                 — public: active sections, in order, with showcase products
 *   GET    /v1/admin/home-sections             — admin: every section
 *   POST   /v1/admin/home-sections             — admin: add a showcase section
 *   PATCH  /v1/admin/home-sections/{id}        — admin: edit (built-ins: status only)
 *   DELETE /v1/admin/home-sections/{id}        — admin: delete a showcase section (built-ins: 409)
 *   PUT    /v1/admin/home-sections/order       — admin: set the order of every section
 *   POST   /v1/admin/home-sections/starter     — admin: add Offers / New collection / Hot picks (idempotent)
 *
 * The two built-in sections ('builtin-banner', 'builtin-catalogue') are seeded
 * by migration 042 and stand for the existing hero banner and product grid.
 *
 * Spec: docs/superpowers/specs/2026-11-23-buy-now-page-builder-design.md §3
 */
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { ErrorResponse, DeletedResponse } from '../schemas';
import { ApiError, uuid, now, type HonoEnv } from '../types';
import { getDb, type Database } from '../db';
import { adminOnly, authMiddleware } from '../middleware/auth';
import { mapProductRows } from './catalog';

const SectionType = z.enum(['banner', 'catalogue', 'showcase']);
const SectionStatus = z.enum(['active', 'hidden']);
const ProductLimit = z.number().int().min(4).max(24);

const HomeSection = z
  .object({
    id: z.string(),
    type: SectionType,
    title: z.string().nullable().openapi({ description: 'Plain text or per-locale JSON; null for built-ins' }),
    category_id: z.string().nullable(),
    category_name: z.string().nullable(),
    category_visibility: z.enum(['listed', 'showcase']).nullable(),
    product_limit: z.number().int(),
    sort_order: z.number().int(),
    status: SectionStatus,
    product_count: z.number().int().openapi({ description: 'Active products in the category' }),
    builtin: z.boolean(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .openapi('HomeSection');

const HomeSectionList = z.object({ items: z.array(HomeSection) }).openapi('HomeSectionList');

const CreateSectionBody = z
  .object({
    title: z.string().min(1).max(2000),
    category_id: z.string().min(1),
    product_limit: ProductLimit.default(12),
    status: SectionStatus.default('active'),
  })
  .openapi('CreateHomeSection');

const UpdateSectionBody = z
  .object({
    title: z.string().min(1).max(2000),
    category_id: z.string().min(1),
    product_limit: ProductLimit,
    status: SectionStatus,
  })
  .partial()
  .openapi('UpdateHomeSection');

const OrderBody = z.object({ ids: z.array(z.string()).min(1).max(500) }).openapi('HomeSectionOrder');
const IdParam = z.object({ id: z.string().min(1) });

type HomeSectionRow = z.infer<typeof HomeSection>;

const SELECT_SECTIONS = `
  SELECT s.*, c.name AS category_name, c.visibility AS category_visibility,
         (SELECT COUNT(*) FROM product_categories pc JOIN products p ON p.id = pc.product_id
           WHERE pc.category_id = s.category_id AND p.status = 'active') AS product_count
  FROM home_sections s
  LEFT JOIN categories c ON c.id = s.category_id`;

function toSection(r: Record<string, unknown>): HomeSectionRow {
  return {
    ...(r as HomeSectionRow),
    category_name: (r.category_name ?? null) as string | null,
    category_visibility: (r.category_visibility ?? null) as HomeSectionRow['category_visibility'],
    product_count: Number(r.product_count ?? 0),
    builtin: r.type !== 'showcase',
  };
}

async function listSections(db: Database): Promise<HomeSectionRow[]> {
  const rows = await db.query<Record<string, unknown>>(`${SELECT_SECTIONS} ORDER BY s.sort_order ASC, s.created_at ASC`);
  return rows.map(toSection);
}

async function getSection(db: Database, id: string): Promise<HomeSectionRow | null> {
  const [row] = await db.query<Record<string, unknown>>(`${SELECT_SECTIONS} WHERE s.id = ?`, [id]);
  return row ? toSection(row) : null;
}

async function requireCategory(db: Database, id: string) {
  const [cat] = await db.query<{ id: string }>(`SELECT id FROM categories WHERE id = ?`, [id]);
  if (!cat) throw ApiError.badRequest('Category does not exist');
}

async function nextSortOrder(db: Database): Promise<number> {
  const [row] = await db.query<{ m: number | null }>(`SELECT MAX(sort_order) AS m FROM home_sections`);
  return (row?.m ?? 0) + 10;
}

// ── Starter sections ──────────────────────────────────────────────────────

const STARTER: Array<{ handle: string; name: Record<string, string> }> = [
  {
    handle: 'offers',
    name: { 'en-US': 'Offers', 'fr-FR': 'Offres', 'es-ES': 'Ofertas', 'zh-CN': '优惠', 'ar-SA': 'العروض', 'he-IL': 'מבצעים', 'bn-BD': 'অফার' },
  },
  {
    handle: 'new-collection',
    name: {
      'en-US': 'New collection', 'fr-FR': 'Nouvelle collection', 'es-ES': 'Nueva colección', 'zh-CN': '新品系列',
      'ar-SA': 'مجموعة جديدة', 'he-IL': 'קולקציה חדשה', 'bn-BD': 'নতুন কালেকশন',
    },
  },
  {
    handle: 'hot-picks',
    name: {
      'en-US': 'Hot picks', 'fr-FR': 'Coups de cœur', 'es-ES': 'Lo más popular', 'zh-CN': '热门精选',
      'ar-SA': 'الأكثر رواجًا', 'he-IL': 'הנבחרים החמים', 'bn-BD': 'জনপ্রিয় বাছাই',
    },
  },
];

// ── Public ────────────────────────────────────────────────────────────────

const PublicSection = z
  .object({
    id: z.string(),
    type: SectionType,
    title: z.string().nullable(),
    products: z.array(z.record(z.string(), z.unknown())).optional().openapi({ description: 'Showcase sections only' }),
  })
  .openapi('PublicHomeSection');

export const publicHome = new OpenAPIHono<HonoEnv>();

publicHome.openapi(
  createRoute({
    method: 'get',
    path: '/home',
    tags: ['Storefront'],
    summary: 'Home page sections',
    description:
      'Active sections in order. Showcase sections carry their category\'s active products (category order, up to the section limit); showcase sections with no products are left out.',
    responses: {
      200: { content: { 'application/json': { schema: z.object({ sections: z.array(PublicSection) }) } }, description: 'Sections' },
    },
  }),
  async (c) => {
    const db = getDb(c.var.db);
    const sections = await db.query<{ id: string; type: 'banner' | 'catalogue' | 'showcase'; title: string | null; category_id: string | null; product_limit: number; category_name: string | null }>(
      `SELECT s.id, s.type, s.title, s.category_id, s.product_limit, c.name AS category_name
       FROM home_sections s
       LEFT JOIN categories c ON c.id = s.category_id
       WHERE s.status = 'active' AND (s.type != 'showcase' OR c.status = 'active')
       ORDER BY s.sort_order ASC, s.created_at ASC`,
    );

    const out: z.infer<typeof PublicSection>[] = [];
    for (const s of sections) {
      if (s.type !== 'showcase') {
        out.push({ id: s.id, type: s.type, title: null });
        continue;
      }
      const products = await db.query<Record<string, unknown>>(
        `SELECT p.* FROM products p
         JOIN product_categories pc ON pc.product_id = p.id
         WHERE pc.category_id = ? AND p.status = 'active'
           -- a product without variants can't be shown as a card or bought
           AND EXISTS (SELECT 1 FROM variants v WHERE v.product_id = p.id)
         ORDER BY pc.position ASC, p.created_at DESC
         LIMIT ?`,
        [s.category_id, s.product_limit],
      );
      if (products.length === 0) continue;
      out.push({
        id: s.id,
        type: 'showcase',
        title: s.title ?? s.category_name,
        products: await mapProductRows(db, products, 'thumb'),
      });
    }
    return c.json({ sections: out }, 200);
  },
);

// Orders that count as a sale: paid and onward, not pending/refunded/canceled.
const SOLD_STATUSES = `('paid', 'processing', 'shipped', 'delivered')`;

publicHome.openapi(
  createRoute({
    method: 'get',
    path: '/best-sellers',
    tags: ['Storefront'],
    summary: 'Best-selling products',
    description:
      'Active products ranked by units sold (all variants) across paid, processing, shipped and delivered orders. Products that never sold are left out.',
    request: {
      query: z.object({ limit: z.coerce.number().int().min(1).max(24).default(12) }),
    },
    responses: {
      200: {
        content: { 'application/json': { schema: z.object({ items: z.array(z.record(z.string(), z.unknown())) }) } },
        description: 'Products, best-selling first',
      },
    },
  }),
  async (c) => {
    const { limit } = c.req.valid('query');
    const db = getDb(c.var.db);
    const ranked = await db.query<Record<string, unknown>>(
      `SELECT p.* FROM products p
       JOIN (
         SELECT v.product_id, SUM(oi.qty) AS sold
         FROM order_items oi
         JOIN orders o ON o.id = oi.order_id
         JOIN variants v ON v.sku = oi.sku
         WHERE o.status IN ${SOLD_STATUSES}
         GROUP BY v.product_id
       ) s ON s.product_id = p.id
       WHERE p.status = 'active'
       ORDER BY s.sold DESC, p.created_at DESC
       LIMIT ?`,
      [limit],
    );
    const items: Record<string, unknown>[] = await mapProductRows(db, ranked, 'thumb');
    return c.json({ items }, 200);
  },
);

// ── Admin ─────────────────────────────────────────────────────────────────

export const adminHomeSections = new OpenAPIHono<HonoEnv>();
adminHomeSections.use('*', authMiddleware);

const security = [{ bearerAuth: ['legacy sk_', 'admin:store'] }];
const tags = ['Page builder'];

adminHomeSections.openapi(
  createRoute({
    method: 'get',
    path: '/',
    tags,
    summary: 'List home page sections',
    security,
    middleware: [adminOnly] as const,
    responses: { 200: { content: { 'application/json': { schema: HomeSectionList } }, description: 'All sections, in order' } },
  }),
  async (c) => c.json({ items: await listSections(getDb(c.var.db)) }, 200),
);

adminHomeSections.openapi(
  createRoute({
    method: 'post',
    path: '/',
    tags,
    summary: 'Add a showcase section',
    security,
    middleware: [adminOnly] as const,
    request: { body: { content: { 'application/json': { schema: CreateSectionBody } } } },
    responses: {
      201: { content: { 'application/json': { schema: HomeSection } }, description: 'Created' },
      400: { content: { 'application/json': { schema: ErrorResponse } }, description: 'Invalid' },
    },
  }),
  async (c) => {
    const body = c.req.valid('json');
    const db = getDb(c.var.db);
    await requireCategory(db, body.category_id);
    const id = uuid();
    const ts = now();
    await db.run(
      `INSERT INTO home_sections (id, type, title, category_id, product_limit, sort_order, status, created_at, updated_at)
       VALUES (?, 'showcase', ?, ?, ?, ?, ?, ?, ?)`,
      [id, body.title, body.category_id, body.product_limit, await nextSortOrder(db), body.status, ts, ts],
    );
    return c.json((await getSection(db, id))!, 201);
  },
);

// Registered before /{id} so "order" and "starter" are not taken as ids.
adminHomeSections.openapi(
  createRoute({
    method: 'put',
    path: '/order',
    tags,
    summary: 'Set the order of every section',
    description: 'ids must list every section exactly once (400 otherwise, e.g. when another admin added or deleted one).',
    security,
    middleware: [adminOnly] as const,
    request: { body: { content: { 'application/json': { schema: OrderBody } } } },
    responses: {
      200: { content: { 'application/json': { schema: HomeSectionList } }, description: 'Sections in the new order' },
      400: { content: { 'application/json': { schema: ErrorResponse } }, description: 'Stale or invalid list' },
    },
  }),
  async (c) => {
    const { ids } = c.req.valid('json');
    const db = getDb(c.var.db);
    const current = await db.query<{ id: string }>(`SELECT id FROM home_sections`);
    const known = new Set(current.map((r) => r.id));
    if (ids.length !== known.size || new Set(ids).size !== ids.length || !ids.every((id) => known.has(id))) {
      throw ApiError.badRequest('The sections have changed since the list was loaded. Reload and try again.');
    }
    // One statement, so the new order is applied all at once.
    const cases = ids.map(() => 'WHEN ? THEN ?').join(' ');
    await db.run(
      `UPDATE home_sections SET sort_order = CASE id ${cases} END, updated_at = ? WHERE id IN (${ids.map(() => '?').join(', ')})`,
      [...ids.flatMap((id, i) => [id, i * 10]), now(), ...ids],
    );
    return c.json({ items: await listSections(db) }, 200);
  },
);

adminHomeSections.openapi(
  createRoute({
    method: 'post',
    path: '/starter',
    tags,
    summary: 'Add the Offers, New collection and Hot picks sections',
    description:
      'Creates the three showcase-only categories (or reuses categories with those handles) and a hidden section for each one that has none. Safe to call again.',
    security,
    middleware: [adminOnly] as const,
    responses: {
      200: {
        content: { 'application/json': { schema: z.object({ items: z.array(HomeSection), created: z.number().int() }) } },
        description: 'All sections, and how many were created',
      },
    },
  }),
  async (c) => {
    const db = getDb(c.var.db);
    let created = 0;
    for (const s of STARTER) {
      const ts = now();
      let [cat] = await db.query<{ id: string }>(`SELECT id FROM categories WHERE handle = ?`, [s.handle]);
      if (!cat) {
        cat = { id: uuid() };
        await db.run(
          `INSERT INTO categories (id, handle, name, position, status, visibility, created_at, updated_at)
           VALUES (?, ?, ?, 0, 'active', 'showcase', ?, ?)`,
          [cat.id, s.handle, JSON.stringify(s.name), ts, ts],
        );
      }
      const [existing] = await db.query<{ id: string }>(`SELECT id FROM home_sections WHERE category_id = ? LIMIT 1`, [cat.id]);
      if (existing) continue;
      await db.run(
        `INSERT INTO home_sections (id, type, title, category_id, product_limit, sort_order, status, created_at, updated_at)
         VALUES (?, 'showcase', ?, ?, 12, ?, 'hidden', ?, ?)`,
        [uuid(), JSON.stringify(s.name), cat.id, await nextSortOrder(db), ts, ts],
      );
      created++;
    }
    return c.json({ items: await listSections(db), created }, 200);
  },
);

adminHomeSections.openapi(
  createRoute({
    method: 'patch',
    path: '/{id}',
    tags,
    summary: 'Edit a section',
    description: 'Built-in sections accept only status.',
    security,
    middleware: [adminOnly] as const,
    request: { params: IdParam, body: { content: { 'application/json': { schema: UpdateSectionBody } } } },
    responses: {
      200: { content: { 'application/json': { schema: HomeSection } }, description: 'Updated' },
      400: { content: { 'application/json': { schema: ErrorResponse } }, description: 'Invalid' },
      404: { content: { 'application/json': { schema: ErrorResponse } }, description: 'Not found' },
    },
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const body = c.req.valid('json');
    const db = getDb(c.var.db);
    const existing = await getSection(db, id);
    if (!existing) throw ApiError.notFound('Section not found');
    if (existing.builtin && (body.title !== undefined || body.category_id !== undefined || body.product_limit !== undefined)) {
      throw ApiError.badRequest('Built-in sections can only be shown or hidden');
    }
    if (body.category_id !== undefined) await requireCategory(db, body.category_id);

    const keys = (['title', 'category_id', 'product_limit', 'status'] as const).filter((k) => body[k] !== undefined);
    if (keys.length > 0) {
      await db.run(
        `UPDATE home_sections SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
        [...keys.map((k) => body[k]), now(), id],
      );
    }
    return c.json((await getSection(db, id))!, 200);
  },
);

adminHomeSections.openapi(
  createRoute({
    method: 'delete',
    path: '/{id}',
    tags,
    summary: 'Delete a showcase section',
    description: 'The category and its products are not deleted. Built-in sections cannot be deleted (409).',
    security,
    middleware: [adminOnly] as const,
    request: { params: IdParam },
    responses: {
      200: { content: { 'application/json': { schema: DeletedResponse } }, description: 'Deleted' },
      404: { content: { 'application/json': { schema: ErrorResponse } }, description: 'Not found' },
      409: { content: { 'application/json': { schema: ErrorResponse } }, description: 'Built-in section' },
    },
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const db = getDb(c.var.db);
    const existing = await getSection(db, id);
    if (!existing) throw ApiError.notFound('Section not found');
    if (existing.builtin) throw ApiError.conflict('Built-in sections can be hidden but not deleted');
    await db.run(`DELETE FROM home_sections WHERE id = ?`, [id]);
    return c.json({ deleted: true as const }, 200);
  },
);
