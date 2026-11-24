/**
 * Home-page banners.
 *
 *   GET    /v1/banners               — public: active banners, in display order
 *   GET    /v1/admin/banners         — admin: every banner (active + draft)
 *   POST   /v1/admin/banners         — admin: create
 *   PATCH  /v1/admin/banners/{id}    — admin: update (partial)
 *   DELETE /v1/admin/banners/{id}    — admin: delete
 *
 * Images are uploaded through POST /v1/images; a banner stores the URL.
 * title/description/labels are plain text or per-locale JSON strings.
 */
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { ErrorResponse, DeletedResponse } from '../schemas';
import { ApiError, uuid, now, type HonoEnv } from '../types';
import { getDb } from '../db';
import { adminOnly, authMiddleware } from '../middleware/auth';
import { isSafeLink } from '../lib/storefront-settings';

const Link = z
  .string()
  .max(500)
  .refine(isSafeLink, { message: 'Must be a path starting with "/" or an http(s) URL' });

const Banner = z
  .object({
    id: z.string(),
    title: z.string(),
    description: z.string(),
    image_url: z.string().nullable(),
    image_alt: z.string(),
    cta_primary_label: z.string().nullable(),
    cta_primary_href: z.string().nullable(),
    cta_secondary_label: z.string().nullable(),
    cta_secondary_href: z.string().nullable(),
    sort_order: z.number().int(),
    status: z.enum(['active', 'draft']),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .openapi('Banner');

const BannerList = z.object({ items: z.array(Banner) }).openapi('BannerList');

const BannerFields = {
  title: z.string().min(1).max(2000),
  description: z.string().max(5000),
  image_url: z.string().url().max(2000).nullable(),
  image_alt: z.string().max(500),
  cta_primary_label: z.string().max(200).nullable(),
  cta_primary_href: Link.nullable(),
  cta_secondary_label: z.string().max(200).nullable(),
  cta_secondary_href: Link.nullable(),
  sort_order: z.number().int().min(0).max(100000),
  status: z.enum(['active', 'draft']),
};

/** A button needs both a label and a link, or neither. */
function checkCtas(b: Record<string, unknown>) {
  for (const which of ['primary', 'secondary'] as const) {
    const label = b[`cta_${which}_label`];
    const href = b[`cta_${which}_href`];
    if (Boolean(label) !== Boolean(href)) {
      throw ApiError.invalidRequest(`The ${which} button needs both a label and a link`);
    }
  }
}

const CreateBannerBody = z
  .object({
    ...BannerFields,
    description: BannerFields.description.default(''),
    image_url: BannerFields.image_url.optional().default(null),
    image_alt: BannerFields.image_alt.default(''),
    cta_primary_label: BannerFields.cta_primary_label.optional().default(null),
    cta_primary_href: BannerFields.cta_primary_href.optional().default(null),
    cta_secondary_label: BannerFields.cta_secondary_label.optional().default(null),
    cta_secondary_href: BannerFields.cta_secondary_href.optional().default(null),
    sort_order: BannerFields.sort_order.default(0),
    status: BannerFields.status.default('draft'),
  })
  .openapi('CreateBanner');

const UpdateBannerBody = z.object(BannerFields).partial().openapi('UpdateBanner');

const IdParam = z.object({ id: z.string().min(1) });

type BannerRow = z.infer<typeof Banner>;

const COLUMNS = [
  'title', 'description', 'image_url', 'image_alt',
  'cta_primary_label', 'cta_primary_href', 'cta_secondary_label', 'cta_secondary_href',
  'sort_order', 'status',
] as const;

// ── Public ────────────────────────────────────────────────────────────────
export const publicBanners = new OpenAPIHono<HonoEnv>();

publicBanners.openapi(
  createRoute({
    method: 'get',
    path: '/',
    tags: ['Banners'],
    summary: 'List active home-page banners',
    responses: { 200: { content: { 'application/json': { schema: BannerList } }, description: 'Active banners' } },
  }),
  async (c) => {
    const items = await getDb(c.var.db).query<BannerRow>(
      `SELECT * FROM banners WHERE status = 'active' ORDER BY sort_order ASC, created_at ASC`,
    );
    return c.json({ items }, 200);
  },
);

// ── Admin ─────────────────────────────────────────────────────────────────
export const adminBanners = new OpenAPIHono<HonoEnv>();
adminBanners.use('*', authMiddleware);

const security = [{ bearerAuth: ['legacy sk_', 'admin:store'] }];

adminBanners.openapi(
  createRoute({
    method: 'get',
    path: '/',
    tags: ['Banners'],
    summary: 'List all banners',
    security,
    middleware: [adminOnly] as const,
    responses: { 200: { content: { 'application/json': { schema: BannerList } }, description: 'All banners' } },
  }),
  async (c) => {
    const items = await getDb(c.var.db).query<BannerRow>(
      `SELECT * FROM banners ORDER BY sort_order ASC, created_at ASC`,
    );
    return c.json({ items }, 200);
  },
);

adminBanners.openapi(
  createRoute({
    method: 'post',
    path: '/',
    tags: ['Banners'],
    summary: 'Create a banner',
    security,
    middleware: [adminOnly] as const,
    request: { body: { content: { 'application/json': { schema: CreateBannerBody } } } },
    responses: {
      201: { content: { 'application/json': { schema: Banner } }, description: 'Created' },
      400: { content: { 'application/json': { schema: ErrorResponse } }, description: 'Invalid' },
    },
  }),
  async (c) => {
    const body = c.req.valid('json');
    checkCtas(body);
    const db = getDb(c.var.db);
    const id = uuid();
    const ts = now();
    await db.run(
      `INSERT INTO banners (id, ${COLUMNS.join(', ')}, created_at, updated_at)
       VALUES (?, ${COLUMNS.map(() => '?').join(', ')}, ?, ?)`,
      [id, ...COLUMNS.map((k) => body[k] ?? null), ts, ts],
    );
    const [row] = await db.query<BannerRow>(`SELECT * FROM banners WHERE id = ?`, [id]);
    return c.json(row, 201);
  },
);

adminBanners.openapi(
  createRoute({
    method: 'patch',
    path: '/{id}',
    tags: ['Banners'],
    summary: 'Update a banner',
    security,
    middleware: [adminOnly] as const,
    request: { params: IdParam, body: { content: { 'application/json': { schema: UpdateBannerBody } } } },
    responses: {
      200: { content: { 'application/json': { schema: Banner } }, description: 'Updated' },
      400: { content: { 'application/json': { schema: ErrorResponse } }, description: 'Invalid' },
      404: { content: { 'application/json': { schema: ErrorResponse } }, description: 'Not found' },
    },
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const body = c.req.valid('json');
    const db = getDb(c.var.db);
    const [existing] = await db.query<BannerRow>(`SELECT * FROM banners WHERE id = ?`, [id]);
    if (!existing) throw ApiError.notFound('Banner not found');

    const keys = COLUMNS.filter((k) => body[k] !== undefined);
    checkCtas({ ...existing, ...body });
    if (keys.length > 0) {
      await db.run(
        `UPDATE banners SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
        [...keys.map((k) => body[k] ?? null), now(), id],
      );
    }
    const [row] = await db.query<BannerRow>(`SELECT * FROM banners WHERE id = ?`, [id]);
    return c.json(row, 200);
  },
);

adminBanners.openapi(
  createRoute({
    method: 'delete',
    path: '/{id}',
    tags: ['Banners'],
    summary: 'Delete a banner',
    security,
    middleware: [adminOnly] as const,
    request: { params: IdParam },
    responses: {
      200: { content: { 'application/json': { schema: DeletedResponse } }, description: 'Deleted' },
      404: { content: { 'application/json': { schema: ErrorResponse } }, description: 'Not found' },
    },
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const db = getDb(c.var.db);
    const [existing] = await db.query<BannerRow>(`SELECT id FROM banners WHERE id = ?`, [id]);
    if (!existing) throw ApiError.notFound('Banner not found');
    await db.run(`DELETE FROM banners WHERE id = ?`, [id]);
    return c.json({ deleted: true as const }, 200);
  },
);
