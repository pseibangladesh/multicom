/**
 * Site content managed from the admin (lib/site-content.ts).
 *
 *   GET    /v1/storefront/social-links          — public: footer social links, in order
 *   GET    /v1/storefront/pages/:handle         — public: saved page edits, by locale
 *   PUT    /v1/admin/settings/social-links      — admin: replace the list
 *   GET    /v1/admin/settings/pages             — admin: which pages have edits
 *   PUT    /v1/admin/settings/pages/:handle     — admin: replace a page's edits
 *   DELETE /v1/admin/settings/pages/:handle     — admin: back to the built-in text
 *
 * None of these are KV-cached, so a save shows on the next storefront fetch.
 */
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { ErrorResponse } from '../schemas';
import { ApiError, type HonoEnv } from '../types';
import { getDb } from '../db';
import { adminOnly, authMiddleware } from '../middleware/auth';
import { SUPPORTED_LANGUAGES } from '../lib/storefront-settings';
import {
  CMS_PAGE_HANDLES,
  MAX_SOCIAL_LINKS,
  SOCIAL_PLATFORMS,
  getCmsPageOverrides,
  getSocialLinks,
  isSafeExternalUrl,
  listEditedCmsPages,
  saveCmsPageOverrides,
  saveSocialLinks,
  type CmsPageOverrides,
} from '../lib/site-content';

const SocialLink = z
  .object({
    platform: z.enum(SOCIAL_PLATFORMS),
    url: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .refine(isSafeExternalUrl, { message: 'Must be a full http(s) URL, e.g. https://facebook.com/yourshop' }),
  })
  .openapi('SocialLink');
const SocialLinks = z.object({ links: z.array(SocialLink).max(MAX_SOCIAL_LINKS) }).openapi('SocialLinks');

const CmsSection = z.object({ heading: z.string().trim().max(200), body: z.string().max(20_000) });
const CmsPageContent = z
  .object({
    title: z.string().trim().min(1).max(200),
    lead: z.string().max(2_000),
    sections: z.array(CmsSection).max(50),
  })
  .openapi('CmsPageContent');
/** Keyed by locale (en-US, bn-BD, ...); a missing locale keeps the built-in text. */
const CmsPageBody = z
  .object({ content: z.record(z.string(), CmsPageContent) })
  .openapi('CmsPageEdits');
const CmsPageResponse = z
  .object({ handle: z.string(), content: z.record(z.string(), CmsPageContent) })
  .openapi('CmsPage');

const HandleParam = z.object({ handle: z.enum(CMS_PAGE_HANDLES) });

// ── Public ────────────────────────────────────────────────────────────────
export const publicSiteContent = new OpenAPIHono<HonoEnv>();

publicSiteContent.openapi(
  createRoute({
    method: 'get',
    path: '/social-links',
    tags: ['Storefront'],
    summary: 'Footer social links',
    responses: { 200: { content: { 'application/json': { schema: SocialLinks } }, description: 'Links, in order' } },
  }),
  async (c) => c.json({ links: await getSocialLinks(getDb(c.var.db)) }, 200),
);

publicSiteContent.openapi(
  createRoute({
    method: 'get',
    path: '/pages/{handle}',
    tags: ['Storefront'],
    summary: 'Saved edits of an informational page',
    description: 'Only the locales an admin edited. The storefront uses its built-in text for the others.',
    request: { params: HandleParam },
    responses: {
      200: { content: { 'application/json': { schema: CmsPageResponse } }, description: 'Edits by locale' },
      400: { content: { 'application/json': { schema: ErrorResponse } }, description: 'Unknown page' },
    },
  }),
  async (c) => {
    const { handle } = c.req.valid('param');
    return c.json({ handle, content: await getCmsPageOverrides(getDb(c.var.db), handle) }, 200);
  },
);

// ── Admin ─────────────────────────────────────────────────────────────────
export const adminSiteContent = new OpenAPIHono<HonoEnv>();
adminSiteContent.use('*', authMiddleware);

const security = [{ bearerAuth: ['legacy sk_', 'admin:store'] }];

adminSiteContent.openapi(
  createRoute({
    method: 'put',
    path: '/social-links',
    tags: ['Storefront'],
    summary: 'Replace the footer social links',
    security,
    middleware: [adminOnly] as const,
    request: { body: { content: { 'application/json': { schema: SocialLinks } } } },
    responses: {
      200: { content: { 'application/json': { schema: SocialLinks } }, description: 'Saved' },
      400: { content: { 'application/json': { schema: ErrorResponse } }, description: 'Invalid' },
    },
  }),
  async (c) => {
    const { links } = c.req.valid('json');
    return c.json({ links: await saveSocialLinks(getDb(c.var.db), links) }, 200);
  },
);

adminSiteContent.openapi(
  createRoute({
    method: 'get',
    path: '/pages',
    tags: ['Storefront'],
    summary: 'Pages and which locales have edits',
    security,
    middleware: [adminOnly] as const,
    responses: {
      200: {
        content: {
          'application/json': {
            schema: z.object({ pages: z.array(z.object({ handle: z.string(), edited_locales: z.array(z.string()) })) }),
          },
        },
        description: 'Pages',
      },
    },
  }),
  async (c) => {
    const edited = await listEditedCmsPages(getDb(c.var.db));
    return c.json(
      { pages: CMS_PAGE_HANDLES.map((handle) => ({ handle, edited_locales: edited[handle] ?? [] })) },
      200,
    );
  },
);

adminSiteContent.openapi(
  createRoute({
    method: 'put',
    path: '/pages/{handle}',
    tags: ['Storefront'],
    summary: "Replace a page's edits",
    description: 'Send every edited locale. A locale left out goes back to the built-in text.',
    security,
    middleware: [adminOnly] as const,
    request: { params: HandleParam, body: { content: { 'application/json': { schema: CmsPageBody } } } },
    responses: {
      200: { content: { 'application/json': { schema: CmsPageResponse } }, description: 'Saved' },
      400: { content: { 'application/json': { schema: ErrorResponse } }, description: 'Invalid' },
    },
  }),
  async (c) => {
    const { handle } = c.req.valid('param');
    const { content } = c.req.valid('json');
    const unknown = Object.keys(content).filter((l) => !(SUPPORTED_LANGUAGES as readonly string[]).includes(l));
    if (unknown.length > 0) throw ApiError.invalidRequest(`Unsupported language: ${unknown.join(', ')}`);
    // Keys were checked just above, so the record is a CmsPageOverrides.
    const saved = await saveCmsPageOverrides(getDb(c.var.db), handle, content as CmsPageOverrides);
    return c.json({ handle, content: saved }, 200);
  },
);

adminSiteContent.openapi(
  createRoute({
    method: 'delete',
    path: '/pages/{handle}',
    tags: ['Storefront'],
    summary: 'Restore the built-in text of a page in every language',
    security,
    middleware: [adminOnly] as const,
    request: { params: HandleParam },
    responses: { 200: { content: { 'application/json': { schema: CmsPageResponse } }, description: 'Restored' } },
  }),
  async (c) => {
    const { handle } = c.req.valid('param');
    await saveCmsPageOverrides(getDb(c.var.db), handle, {});
    return c.json({ handle, content: {} }, 200);
  },
);
