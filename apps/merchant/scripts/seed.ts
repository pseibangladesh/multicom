#!/usr/bin/env npx tsx
/**
 * MIT License
 *
 * Copyright (c) 2026 Ronan Le Meillat - SCTG Development
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

/**
 * Seed script - creates demo data via the API
 *
 * Maintainers and contributors should use this script to populate a local
 * or test environment with realistic sample data sets (regions, tax rates,
 * categories, products, inventory, orders, and reviews).
 *
 * Idempotent: every record is looked up by a natural key first (handle, SKU,
 * display name, tax code, customer email) and only created when missing, so a
 * run that failed halfway can simply be started again.
 *
 * Usage:
 *   npx tsx scripts/seed.ts <api_url> <admin_key> [--force]
 *   npx tsx scripts/seed.ts http://localhost:8787 sk_...
 *
 *   --force  wipe the demo data first (local workers only, see
 *            POST /v1/setup/demo-reset), then seed from scratch.
 *
 * This file has two main responsibilities:
 *  1. structural organization of data (PRODUCT_CATALOG, SEED_ADDRESSES, etc.)
 *  2. orchestration functions that call the API in a safe order.
 *
 * When extending, add new seed helpers near the bottom and ensure the
 * `seed()` orchestrator is updated.
 */

// images are embedded as base64 so this file can run even after the PNGs are removed
import { imageMap } from './image_map';
import {
  EUROPEAN_COUNTRIES,
  UK_COUNTRIES,
  US_COUNTRIES,
  OTHER_COUNTRIES,
} from './seed-data';
import { readFileSync, existsSync } from 'node:fs';
import { join as pathJoin, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import webpWasm from 'webp-wasm';
import { PNG } from 'pngjs';
import { decode as decodeJpeg } from 'jpeg-js';

// Derive __dirname for ESM context (tsx/Node ESM do not expose __dirname natively)
const __dirname = dirname(fileURLToPath(import.meta.url));

const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const FORCE = process.argv.includes('--force');
const API_URL = positional[0] || 'http://localhost:8787';
const API_KEY = positional[1];

if (!API_KEY) {
  console.log(`
🌱 Seed Script - Create demo data

Usage:
  npx tsx scripts/seed.ts <api_url> <admin_key> [--force]

Example:
  npx tsx scripts/seed.ts http://localhost:8787 sk_abc123...
  npx tsx scripts/seed.ts http://localhost:8787 sk_abc123... --force   # wipe demo data, reseed

First, start the API and create a store:
  npm run dev
  # Then in browser or curl, the first request will prompt you to set up
`);
  process.exit(1);
}

/**
 * fetch() that waits out 429s (Retry-After) instead of failing. The API allows
 * 100 requests/min per key unless the key has the `sk_` admin prefix (2000/min),
 * and a full seed makes several hundred requests.
 */
async function fetchRetrying(url: string, init: RequestInit, maxRetries = 10): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, init);
    if (res.status !== 429 || attempt > maxRetries) return res;
    const waitSec = Math.max(1, Number(res.headers.get('Retry-After')) || 2 ** attempt);
    console.log(`   ⏳ Rate limited, waiting ${waitSec}s (retry ${attempt}/${maxRetries})...`);
    await new Promise((resolve) => setTimeout(resolve, waitSec * 1000));
  }
}

/**
 * Primary low-level API helper.
 *
 * @param path Relative endpoint path, e.g. '/v1/products'.
 * @param body Optional JSON payload for POST requests (GET if omitted).
 * @returns Parsed JSON body of the response.
 * @throws if the request fails or returns non-2xx status.
 */
async function api(path: string, body?: any) {
  const res = await fetchRetrying(`${API_URL}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`${path}: ${err.error?.message || res.statusText}`);
  }

  return res.json();
}

/** GET that returns null on 404 instead of throwing. */
async function apiGetOrNull(path: string): Promise<any | null> {
  const res = await fetchRetrying(`${API_URL}${path}`, { headers: { Authorization: `Bearer ${API_KEY}` } });
  if (res.status === 404) return null;
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`${path}: ${(err as any).error?.message || res.statusText}`);
  }
  return res.json();
}

/**
 * The API stores a product handle as per-locale JSON ({"en-US":"classic-tee"});
 * older rows may hold a plain string. Returns every handle value it contains.
 */
function handleValues(raw: unknown): string[] {
  if (typeof raw !== 'string' || raw === '') return [];
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return Object.values(parsed).filter((v): v is string => typeof v === 'string');
  } catch {
    // not JSON: a plain handle
  }
  return [raw];
}

/** Logs whether a record was reused or created, for a readable re-run. */
function logEnsure(created: boolean, label: string) {
  console.log(created ? `   ✅ ${label}` : `   ↩  ${label} (already exists)`);
}

/**
 * Find-or-create on a list endpoint: returns the first item matching `match`,
 * otherwise POSTs `body` to `path`. The list endpoints used here cap at 500
 * rows, far more than the demo data needs.
 */
async function ensureListed(
  path: string,
  match: (item: any) => boolean,
  body: Record<string, unknown>,
  label: string,
): Promise<any> {
  const sep = path.includes('?') ? '&' : '?';
  const { items } = await api(`${path}${sep}limit=500`);
  const existing = (items as any[]).find(match);
  if (existing) {
    logEnsure(false, label);
    return existing;
  }
  const created = await api(path, body);
  logEnsure(true, label);
  return created;
}

/**
 * Convert currency amounts from EUR cents to target currency cents.
 *
 * This uses integer cents and rounds to avoid floating-point pricing errors
 * in currency price conversions during seeding.
 *
 * @param cents Price in EUR cents.
 * @param rate Exchange rate multiplier to target currency.
 * @returns Rounded price in target currency cents.
 */
function convertCents(cents: number, rate: number): number {
  return Math.round(cents * rate);
}

const EUR_TO_USD = 1.14;
const EUR_TO_GBP = 0.86;

/**
 * Nearest-neighbour resize of raw RGBA pixel data.
 *
 * This is a performance-oriented downscale helper used to generate thumbnails
 * for seeded product images without external image libraries, besides WebP.
 *
 * @param src Source RGBA pixel buffer.
 * @param srcW Source width in pixels.
 * @param srcH Source height in pixels.
 * @param dstW Destination width in pixels.
 * @param dstH Destination height in pixels.
 * @returns Resized RGBA buffer.
 */
function nnsResize(
  src: Uint8ClampedArray,
  srcW: number, srcH: number,
  dstW: number, dstH: number,
): Uint8ClampedArray {
  const dst = new Uint8ClampedArray(dstW * dstH * 4);
  const xRatio = srcW / dstW;
  const yRatio = srcH / dstH;
  for (let y = 0; y < dstH; y++) {
    for (let x = 0; x < dstW; x++) {
      const sx = Math.min(Math.floor(x * xRatio), srcW - 1);
      const sy = Math.min(Math.floor(y * yRatio), srcH - 1);
      const si = (sy * srcW + sx) * 4;
      const di = (y * dstW + x) * 4;
      dst[di] = src[si]; dst[di + 1] = src[si + 1]; dst[di + 2] = src[si + 2]; dst[di + 3] = src[si + 3];
    }
  }
  return dst;
}

/**
 * Decode a PNG/JPEG image source and re-encode as a WebP data URI.
 *
 * This helper supports images in either filesystem path (./img) or base64 data
 * embedded in `seed-data` so the script remains self-contained.
 *
 * @param src Filename in ./img/ OR a data:image/...;base64,... string from imageMap.
 * @param maxSide Pixel limit: scales proportionally when any dimension exceeds this.
 * @param quality WebP quality 0-100.
 * @returns Data URI string or null when source is missing/unreadable.
 */
async function toWebpDataUri(
  src: string | null,
  maxSide: number,
  quality = 80,
): Promise<string | null> {
  if (!src) return null;

  let rawBuffer: Buffer;
  let ext: string;

  if (src.startsWith('data:')) {
    const comma = src.indexOf(',');
    const header = src.slice(0, comma);
    rawBuffer = Buffer.from(src.slice(comma + 1), 'base64');
    ext = header.includes('png') ? 'png' : 'jpg';
  } else {
    const imgPath = pathJoin(__dirname, 'img', src);
    if (!existsSync(imgPath)) return null;
    rawBuffer = readFileSync(imgPath);
    ext = src.split('.').pop()?.toLowerCase() ?? 'png';
  }

  let rgba: Uint8ClampedArray;
  let width: number;
  let height: number;

  if (ext === 'png') {
    const png = PNG.sync.read(rawBuffer);
    width = png.width;
    height = png.height;
    rgba = new Uint8ClampedArray(png.data.buffer, png.data.byteOffset, png.data.byteLength);
  } else {
    const decoded = decodeJpeg(rawBuffer, { useTArray: true });
    width = decoded.width;
    height = decoded.height;
    rgba = new Uint8ClampedArray(decoded.data.buffer, decoded.data.byteOffset, decoded.data.byteLength);
  }

  if (width > maxSide || height > maxSide) {
    const scale = maxSide / Math.max(width, height);
    const newW = Math.round(width * scale);
    const newH = Math.round(height * scale);
    rgba = nnsResize(rgba, width, height, newW, newH);
    width = newW;
    height = newH;
  }

  const webpBuf = await webpWasm.encode({ data: rgba, width, height } as any, { quality });
  return `data:image/webp;base64,${Buffer.from(webpBuf).toString('base64')}`;
}

/**
 * Helper for PATCH requests to the admin API.
 *
 * @param path API path.
 * @param body JSON patch body.
 * @returns Parsed JSON response.
 */
async function apiPatch(path: string, body: any): Promise<any> {
  const res = await fetchRetrying(`${API_URL}${path}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`PATCH ${path}: ${(err as any).error?.message || res.statusText}`);
  }
  return res.json();
}

/**
 * Seed tax rates used by product prices.
 *
 * This function is usually safe to run repeatedly against the same database.
 * It creates both a standard rate and a reduced food rate used for certain SKUs.
 */
async function seedTaxes() {
  console.log('💰 Creating VAT rates...');
  const vatNames = JSON.stringify({
    'en-US': 'VAT',
    'fr-FR': 'TVA',
    'es-ES': 'IVA',
    'ar-SA': 'ضريبة القيمة المضافة',
    'zh-CN': '增值税',
    'he-IL': 'מע"מ',
  });

  const sameRate = (code: string, pct: number) => (t: any) =>
    t.tax_code === code && Number(t.rate_percentage) === pct;

  const tax20 = await ensureListed('/v1/tax-rates', sameRate('txcd_99999999', 20), {
    display_name: vatNames,
    tax_code: 'txcd_99999999',
    rate_percentage: 20.0,
  }, 'VAT 20%');

  const tax5 = await ensureListed('/v1/tax-rates', sameRate('txcd_20010000', 5.5), {
    display_name: vatNames,
    tax_code: 'txcd_20010000', // Reduced VAT for food in France
    rate_percentage: 5.5,
  }, 'VAT 5.5%');

  return { tax20, tax5 };
}

/**
 * Seed product categories and nested subcategories.
 *
 * Returns a map of category keys to category IDs, used by product-category
 * assignments in seedProducts().
 */
async function seedCategories() {
  console.log('📁 Creating categories...');

  // Existing categories by handle (UNIQUE), so re-runs reuse them and skip
  // the image conversion.
  const { items: existingCats } = await api('/v1/categories');
  const catByHandle = new Map<string, any>((existingCats as any[]).map((c) => [c.handle, c]));

  // Helper: find a category by handle, or create it with WebP image_url and thumbnail_url
  async function createCat(data: Record<string, any>, imageFile: string) {
    const existing = catByHandle.get(data.handle);
    if (existing) {
      logEnsure(false, `category ${data.handle}`);
      return existing;
    }
    logEnsure(true, `category ${data.handle}`);
    const imageUrl = await toWebpDataUri(imageFile, 1200, 80);
    const thumbUrl  = await toWebpDataUri(imageFile, 300, 80);
    return api('/v1/categories', {
      ...data,
      ...(imageUrl ? { image_url: imageUrl } : {}),
      ...(thumbUrl  ? { thumbnail_url: thumbUrl } : {}),
    });
  }

  // Niche parents (client brief: "target the first group of niches").
  // Every subcategory and product below sits under one of these.
  const ecoJuteGoods = await createCat({
    handle: 'eco-jute-goods',
    name: JSON.stringify({
      'en-US': 'Eco-friendly Jute Goods',
      'fr-FR': 'Articles en jute écologiques',
      'es-ES': 'Artículos ecológicos de yute',
      'zh-CN': '环保黄麻制品',
      'ar-SA': 'منتجات الجوت الصديقة للبيئة',
      'he-IL': 'מוצרי יוטה ידידותיים לסביבה',
      'bn-BD': 'পরিবেশবান্ধব পাটপণ্য',
    }),
    description: JSON.stringify({
      'en-US': 'Bags, mats and homeware in jute and natural fibres: the golden fibre of Bengal, made to last and to compost.',
      'fr-FR': 'Sacs, tapis et objets pour la maison en jute et fibres naturelles : la fibre dorée du Bengale, faite pour durer.',
      'es-ES': 'Bolsas, alfombras y artículos para el hogar en yute y fibras naturales: la fibra dorada de Bengala, hecha para durar.',
      'zh-CN': '黄麻与天然纤维制成的包袋、地垫和家居用品——孟加拉的“金色纤维”，经久耐用、可降解。',
      'ar-SA': 'حقائب وسجاد ومستلزمات منزلية من الجوت والألياف الطبيعية: الألياف الذهبية للبنغال، مصنوعة لتدوم.',
      'he-IL': 'תיקים, שטיחונים וכלי בית מיוטה וסיבים טבעיים: הסיב הזהוב של בנגל, עשוי להחזיק מעמד.',
      'bn-BD': 'পাট ও প্রাকৃতিক আঁশে তৈরি ব্যাগ, পাপোশ ও ঘরের জিনিস: বাংলার সোনালি আঁশ, টেকসই ও পরিবেশবান্ধব।',
    }),
  }, 'bags-carry.png');

  const techWearables = await createCat({
    handle: 'tech-wearables',
    name: JSON.stringify({
      'en-US': 'Modern Tech Wearables',
      'fr-FR': 'Tech et streetwear',
      'es-ES': 'Tecnología y ropa urbana',
      'zh-CN': '潮流科技穿戴',
      'ar-SA': 'ملابس وإكسسوارات تقنية عصرية',
      'he-IL': 'טכנולוגיה ולבוש מודרני',
      'bn-BD': 'আধুনিক টেক ও পোশাক',
    }),
    description: JSON.stringify({
      'en-US': 'Streetwear, phone cases and desk tech with Bengali street-art prints, for a generation that lives online.',
      'fr-FR': 'Streetwear, coques de téléphone et accessoires de bureau aux motifs d’art de rue bengali.',
      'es-ES': 'Ropa urbana, fundas de móvil y accesorios de escritorio con estampados de arte callejero bengalí.',
      'zh-CN': '印有孟加拉街头艺术图案的潮服、手机壳和桌面科技配件。',
      'ar-SA': 'ملابس شارع وأغطية هواتف وإكسسوارات مكتبية بنقوش فن الشارع البنغالي.',
      'he-IL': 'בגדי רחוב, כיסויי טלפון ואביזרי שולחן עם הדפסי אמנות רחוב בנגלית.',
      'bn-BD': 'বাংলার রিকশা-আর্ট ও আলপনার নকশায় স্ট্রিটওয়্যার, ফোন কভার ও ডেস্কের টেক অনুষঙ্গ।',
    }),
  }, 'accessories-tech.png');

  const artisanCrafts = await createCat({
    handle: 'artisan-crafts',
    name: JSON.stringify({
      'en-US': 'South Asian Artisan Crafts',
      'fr-FR': 'Artisanat d’Asie du Sud',
      'es-ES': 'Artesanía del sur de Asia',
      'zh-CN': '南亚手工艺品',
      'ar-SA': 'حرف يدوية من جنوب آسيا',
      'he-IL': 'אומנות יד מדרום אסיה',
      'bn-BD': 'দক্ষিণ এশিয়ার কারুশিল্প',
    }),
    description: JSON.stringify({
      'en-US': 'Nakshi kantha, terracotta and hand-finished pieces from makers across Bengal.',
      'fr-FR': 'Nakshi kantha, terre cuite et pièces finies à la main par des artisans du Bengale.',
      'es-ES': 'Nakshi kantha, terracota y piezas acabadas a mano por artesanos de Bengala.',
      'zh-CN': '来自孟加拉各地匠人的纳克希坎塔刺绣、陶器和手工制品。',
      'ar-SA': 'نكشي كانثا وفخار وقطع مشغولة يدويًا من حرفيي البنغال.',
      'he-IL': 'נקשי קנתה, טרקוטה ופריטים בגימור יד מאומנים ברחבי בנגל.',
      'bn-BD': 'বাংলার কারিগরদের হাতে তৈরি নকশিকাঁথা, পোড়ামাটি ও হস্তশিল্প।',
    }),
  }, 'home-living.png');

  // Create child categories
  const classicTeesCategory = await createCat({
    handle: 'classic-tees',
    name: JSON.stringify({
      'en-US': 'Classic Tees',
      'fr-FR': 'T-Shirts Classiques',
      'es-ES': 'Camisetas Clásicas',
      'zh-CN': '经典T恤',
      'ar-SA': 'تي شيرتات كلاسيكية',
      'he-IL': 'טי שירטים קלאסיים',
    }),
    description: JSON.stringify({
      'en-US': 'SCTG classic tees',
      'fr-FR': 'T-shirts classiques SCTG',
      'es-ES': 'Camisetas clásicas SCTG',
      'zh-CN': 'SCTG经典T恤',
      'ar-SA': 'تي شيرتات SCTG الكلاسيكية',
      'he-IL': 'טי שירטים קלאסיים של SCTG',
    }),
    parent_id: techWearables.id,
  }, 'classic-tees.png');

  const capsCategory = await createCat({
    handle: 'caps',
    name: JSON.stringify({
      'en-US': 'Caps',
      'fr-FR': 'Casquettes',
      'es-ES': 'Gorras',
      'zh-CN': '帽子',
      'ar-SA': 'قبعات',
      'he-IL': 'כובעים',
    }),
    description: JSON.stringify({
      'en-US': 'SCTG caps',
      'fr-FR': 'Casquettes SCTG',
      'es-ES': 'Gorras SCTG',
      'zh-CN': 'SCTG帽子',
      'ar-SA': 'قبعات SCTG',
      'he-IL': 'כובעים של SCTG',
    }),
    parent_id: techWearables.id,
  }, 'caps.png');

  const hoodiesCategory = await createCat({
    handle: 'hoodies',
    name: JSON.stringify({
      'en-US': 'Hoodies',
      'fr-FR': 'Sweats à Capuche',
      'es-ES': 'Sudaderas con Capucha',
      'zh-CN': '连帽衫',
      'ar-SA': 'هوديز',
      'he-IL': 'סווטשירטים',
    }),
    description: JSON.stringify({
      'en-US': 'SCTG Hoodies',
      'fr-FR': 'Sweats à Capuche SCTG',
      'es-ES': 'Sudaderas con Capucha SCTG',
      'zh-CN': 'SCTG连帽衫',
      'ar-SA': 'هوديز SCTG',
      'he-IL': 'סווטשירטים של SCTG',
    }),
    parent_id: techWearables.id,
  }, 'hoodies.png');

  const stickersCategory = await createCat({
    handle: 'stickers-category',
    name: JSON.stringify({
      'en-US': 'Stickers',
      'fr-FR': 'Autocollants',
      'es-ES': 'Pegatinas',
      'zh-CN': '贴纸',
      'ar-SA': 'ملصقات',
      'he-IL': 'מדבקות',
    }),
    description: JSON.stringify({
      'en-US': 'SCTG stickers',
      'fr-FR': 'Autocollants SCTG',
      'es-ES': 'Pegatinas SCTG',
      'zh-CN': 'SCTG贴纸',
      'ar-SA': 'ملصقات SCTG',
      'he-IL': 'מדבקות של SCTG',
    }),
    parent_id: techWearables.id,
  }, 'stickers-category.png');

  const bagsCarryCategory = await createCat({
    handle: 'bags-carry',
    name: JSON.stringify({
      'en-US': 'Bags & Carry',
      'fr-FR': 'Sacs et transport',
      'es-ES': 'Bolsas y transporte',
      'ar-SA': 'الحقائب والحمل',
      'zh-CN': '箱包与携带',
      'he-IL': 'תיקים ונשיאה',
    }),
    description: JSON.stringify({
      'en-US': 'Products designed for carrying, storage and everyday transport.',
      'fr-FR': 'Produits conçus pour le transport, le rangement et l’usage nomade au quotidien.',
      'es-ES': 'Productos diseñados para transportar, guardar y llevar a diario.',
      'ar-SA': 'منتجات مخصصة للحمل والتخزين والتنقل اليومي.',
      'zh-CN': '用于携带、收纳和日常运输的产品。',
      'he-IL': 'מוצרים המיועדים לנשיאה, אחסון והובלה יומיומית.',
    }),
    parent_id: ecoJuteGoods.id,
  }, 'bags-carry.png');

  const drinkwareCategory = await createCat({
    handle: 'drinkware',
    name: JSON.stringify({
      'en-US': 'Drinkware',
      'fr-FR': 'Boissons et contenants',
      'es-ES': 'Bebida y recipientes',
      'ar-SA': 'أدوات الشرب',
      'zh-CN': '饮具',
      'he-IL': 'כלי שתייה',
    }),
    description: JSON.stringify({
      'en-US': 'Reusable beverage containers and drink-related products for daily use or gifting.',
      'fr-FR': 'Contenants réutilisables pour boissons et produits liés à la consommation au quotidien ou en cadeau.',
      'es-ES': 'Recipientes reutilizables para bebidas y productos relacionados para uso diario o regalo.',
      'ar-SA': 'حاويات قابلة لإعادة الاستخدام للمشروبات ومنتجات مرتبطة بها للاستخدام اليومي أو الهدايا.',
      'zh-CN': '适合日常使用或赠礼的可重复使用饮品容器及相关产品。',
      'he-IL': 'מכלי שתייה רב-פעמיים ומוצרים קשורים לשימוש יומיומי או כמתנה.',
    }),
    parent_id: artisanCrafts.id,
  }, 'drinkware.png');

  const accessoriesTechCategory = await createCat({
    handle: 'accessories-tech',
    name: JSON.stringify({
      'en-US': 'Accessories & Tech',
      'fr-FR': 'Accessoires et tech',
      'es-ES': 'Accesorios y tecnología',
      'ar-SA': 'الإكسسوارات والتقنية',
      'zh-CN': '配件与科技',
      'he-IL': 'אביזרים וטכנולוגיה',
    }),
    description: JSON.stringify({
      'en-US': 'Small promotional items, desk accessories and tech-oriented everyday products.',
      'fr-FR': 'Petits objets promotionnels, accessoires de bureau et produits tech du quotidien.',
      'es-ES': 'Pequeños artículos promocionales, accesorios de escritorio y productos tecnológicos de uso diario.',
      'ar-SA': 'منتجات ترويجية صغيرة وإكسسوارات مكتبية ومنتجات تقنية للاستخدام اليومي.',
      'zh-CN': '小型促销品、桌面配件及日常科技类产品。',
      'he-IL': 'פריטי קידום קטנים, אביזרי שולחן ומוצרים טכנולוגיים לשימוש יומיומי.',
    }),
    parent_id: techWearables.id,
  }, 'accessories-tech.png');

  const homeLivingCategory = await createCat({
    handle: 'home-living',
    name: JSON.stringify({
      'en-US': 'Home & Living',
      'fr-FR': 'Maison et lifestyle',
      'es-ES': 'Hogar y estilo de vida',
      'ar-SA': 'المنزل ونمط الحياة',
      'zh-CN': '家居与生活方式',
      'he-IL': 'בית ולייף סטייל',
    }),
    description: JSON.stringify({
      'en-US': 'Comfort, decor and practical products intended for home, lounge or personal spaces.',
      'fr-FR': 'Produits de confort, de décoration et d’usage pratique pour la maison, les espaces lounge ou personnels.',
      'es-ES': 'Productos de confort, decoración y uso práctico para el hogar, zonas lounge o espacios personales.',
      'ar-SA': 'منتجات للراحة والديكور والاستخدام العملي مخصصة للمنزل أو لمساحات الاستراحة أو المساحات الشخصية.',
      'zh-CN': '适用于家居、休闲区或个人空间的舒适、装饰和实用产品。',
      'he-IL': 'מוצרי נוחות, עיצוב ושימוש פרקטי לבית, לאזורי ישיבה או למרחבים אישיים.',
    }),
    parent_id: ecoJuteGoods.id,
  }, 'home-living.png');

  const digitalProductsCategory = await createCat({
    handle: 'digital-products',
    name: JSON.stringify({
      'en-US': 'Digital Products',
      'fr-FR': 'Produits numériques',
      'es-ES': 'Productos digitales',
      'zh-CN': '数字产品',
      'ar-SA': 'المنتجات الرقمية',
      'he-IL': 'מוצרים דיגיטליים',
    }),
    description: JSON.stringify({
      'en-US': 'Downloadable files and digital content delivered instantly after purchase.',
      'fr-FR': 'Fichiers téléchargeables et contenus numériques livrés instantanément après achat.',
      'es-ES': 'Archivos descargables y contenido digital entregado instantáneamente tras la compra.',
      'zh-CN': '购买后即时交付的可下载文件和数字内容。',
      'ar-SA': 'ملفات قابلة للتنزيل ومحتوى رقمي يُسلَّم فوراً بعد الشراء.',
      'he-IL': 'קבצים להורדה ותוכן דיגיטלי שמסופקים מיידית לאחר הרכישה.',
    }),
    parent_id: techWearables.id,
  }, 'digitalproducts.png');

  const aiTokensCategory = await createCat({
    handle: 'ai-tokens',
    name: JSON.stringify({
      'en-US': 'AI Credits',
      'fr-FR': 'Crédits IA',
      'es-ES': 'Créditos IA',
      'zh-CN': 'AI 积分',
      'ar-SA': 'رصيد الذكاء الاصطناعي',
      'he-IL': 'קרדיטים לבינה מלאכותית',
    }),
    description: JSON.stringify({
      'en-US': 'AI token packages — purchase credits to use with AI-powered features.',
      'fr-FR': 'Packs de tokens IA — achetez des crédits pour utiliser les fonctionnalités IA.',
      'es-ES': 'Paquetes de tokens IA — compra créditos para usar las funciones con IA.',
      'zh-CN': 'AI 积分包 — 购买积分以使用 AI 功能。',
      'ar-SA': 'حزم رموز الذكاء الاصطناعي — اشترِ الرصيد لاستخدام ميزات الذكاء الاصطناعي.',
      'he-IL': 'חבילות טוקנים של בינה מלאכותית — רכוש קרדיטים לשימוש בתכונות AI.',
    }),
    parent_id: techWearables.id,
  }, 'aitokens.png');

  return {
    ecoJuteGoods: ecoJuteGoods.id,
    techWearables: techWearables.id,
    artisanCrafts: artisanCrafts.id,
    classicTees: classicTeesCategory.id,
    caps: capsCategory.id,
    hoodies: hoodiesCategory.id,
    stickers: stickersCategory.id,
    bagsCarry: bagsCarryCategory.id,
    drinkware: drinkwareCategory.id,
    accessoriesTech: accessoriesTechCategory.id,
    homeLiving: homeLivingCategory.id,
    digitalProducts: digitalProductsCategory.id,
    aiTokens: aiTokensCategory.id,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Unified product catalog
// Every product — legacy apparel or additional catalog — lives here.
// To add a product: push a new entry; variants drive inventory & pricing.
//
// Each item in product catalog must include:
// - key: short lookup key used by SEED_REVIEWS and seeds
// - handle: API product handle
// - categories: array of category handles
// - variants: variant rows with sku/price_cents/stock
//
// Contributors: keeping this list in English + i18n maps encourages
// consistent localization across all languages.
// ─────────────────────────────────────────────────────────────────────────────

const PRODUCT_CATALOG = [
  // ── SCTG Branded Apparel ───────────────────────────────────────────────────
  {
    key: 'tee', file: 'tee-black.png', handle: 'classic-tee', vendor: 'SCTG',
    categories: ['classic-tees'],
    title:       { 'en-US': 'Classic Tee',          'fr-FR': 'T-Shirt Classique',       'es-ES': 'Camiseta Clásica',         'zh-CN': '经典T恤',       'ar-SA': 'تي شيرت كلاسيكي',   'he-IL': 'טי שירט קלאסי' },
    description: { 'en-US': '<p>Premium cotton t-shirt. Soft, breathable, and built to last, with our logo…</p>', 'fr-FR': '<p>T-shirt en coton premium. Doux, respirant et conçu pour durer, avec notre logo…</p>', 'es-ES': '<p>Camiseta de algodón premium. Suave, transpirable y duradera, con nuestro logo…</p>', 'zh-CN': '<p>优质棉质T恤。柔软、透气、经久耐用，印有我们的标志…</p>', 'ar-SA': '<p>تي شيرت قطني فاخر. ناعم، قابل للتنفس، ومصمم ليدوم طويلاً، مع شعارنا…</p>', 'he-IL': '<p>חולצת טי כותנה פרימיום. רכה, נושמת ובנויה להחזיק מעמד, עם הלוגו שלנו…</p>' },
    variants: [
      { sku: 'TEE-BLK-S', title: 'Black / S', price_cents: 2999, weight_g: 180, stock: 50, imageFile: 'tee-black.png' },
      { sku: 'TEE-BLK-M', title: 'Black / M', price_cents: 2999, weight_g: 200, stock: 75, imageFile: 'tee-black.png' },
      { sku: 'TEE-BLK-L', title: 'Black / L', price_cents: 2999, weight_g: 220, stock: 60, imageFile: 'tee-black.png' },
      { sku: 'TEE-WHT-S', title: 'White / S', price_cents: 2999, weight_g: 180, stock: 40, imageFile: 'tee-white.png' },
      { sku: 'TEE-WHT-M', title: 'White / M', price_cents: 2999, weight_g: 200, stock: 55, imageFile: 'tee-white.png' },
      { sku: 'TEE-WHT-L', title: 'White / L', price_cents: 2999, weight_g: 220, stock: 45, imageFile: 'tee-white.png' },
    ],
  },
  {
    key: 'hoodie', file: 'hoodie-black.png', handle: 'hoodie', vendor: 'SCTG',
    categories: ['hoodies'],
    title:       { 'en-US': 'Hoodie',             'fr-FR': 'Sweat à capuche',          'es-ES': 'Sudadera con capucha',     'zh-CN': '连帽衫',       'ar-SA': 'هودي',               'he-IL': 'סווטשירט עם כובע' },
    description: { 'en-US': '<p>Cozy pullover hoodie with large logo. Perfect for coding sessions…</p>', 'fr-FR': '<p>Sweat à capuche confortable avec grand logo. Parfait pour les sessions de codage…</p>', 'es-ES': '<p>Sudadera con capucha cómoda y gran logo. Perfecta para sesiones de programación…</p>', 'zh-CN': '<p>舒适的连帽衫，带有大标志。非常适合编码会话…</p>', 'ar-SA': '<p>سويت بالكلاو مريح مع شعار كبير. مثالية لجلسات البرمجة…</p>', 'he-IL': '<p>חולצת קפואה נוחה עם לוגו גדול. מושלמת לישיבות תכנות…</p>' },
    variants: [
      { sku: 'HOOD-BLK-M', title: 'Black / M', price_cents: 5999, weight_g: 520, stock: 30, imageFile: 'hoodie-black.png' },
      { sku: 'HOOD-BLK-L', title: 'Black / L', price_cents: 5999, weight_g: 560, stock: 25, imageFile: 'hoodie-black.png' },
      { sku: 'HOOD-GRY-M', title: 'Gray / M',  price_cents: 5999, weight_g: 520, stock: 20, imageFile: 'hoodie-white.png' },
      { sku: 'HOOD-GRY-L', title: 'Gray / L',  price_cents: 5999, weight_g: 560, stock: 15, imageFile: 'hoodie-white.png' },
    ],
  },
  {
    key: 'cap', file: 'cap-black.png', handle: 'cap', vendor: 'SCTG',
    categories: ['caps'],
    title:       { 'en-US': 'Cap',                'fr-FR': 'Casquette',                'es-ES': 'Gorra',                    'zh-CN': '棒球帽',       'ar-SA': 'قبعة',               'he-IL': 'כובע' },
    description: { 'en-US': '<p><strong>Embroidered</strong> baseball cap with logo. One size fits all heads…</p>', 'fr-FR': '<p>Casquette de baseball brodée avec logo. Une taille convient à toutes les têtes…</p>', 'es-ES': '<p>Gorra de béisbol bordada con logo. Talla única para todas las cabezas…</p>', 'zh-CN': '<p>刺绣棒球帽，带有标志。适合所有头型…</p>', 'ar-SA': '<p>قبعة بيسبول مخيطة بشعار. مقاس واحد يناسب جميع الرؤوس…</p>', 'he-IL': '<p>כובע בייסבול רקום עם לוגו. גודל אחד מתאים לכל הראש…</p>' },
    variants: [
      { sku: 'CAP-BLK', title: 'Black', price_cents: 2499, weight_g: 120, stock: 100, imageFile: 'cap-black.png' },
      { sku: 'CAP-NVY', title: 'Navy',  price_cents: 2499, weight_g: 120, stock: 80,  imageFile: 'cap-navy.png'  },
    ],
  },
  {
    key: 'sticker', file: 'stickers.png', handle: 'sticker-pack', vendor: 'SCTG',
    categories: ['stickers'],
    title:       { 'en-US': 'Sticker Pack',       'fr-FR': "Pack d'autocollants",      'es-ES': 'Paquete de pegatinas',     'zh-CN': '贴纸包',       'ar-SA': 'مجموعة ملصقات',      'he-IL': 'חבילת מדבקות' },
    description: { 'en-US': '<p>Set of 5 die-cut vinyl stickers. Beautiful, waterproof and durable…</p>', 'fr-FR': '<p>Ensemble de 5 autocollants en vinyle découpés. Beaux, imperméables et durables…</p>', 'es-ES': '<p>Set de 5 pegatinas de vinilo recortadas. Hermosas, impermeables y duraderas…</p>', 'zh-CN': '<p>5件套模切乙烯基贴纸。美观、防水且耐用…</p>', 'ar-SA': '<p>مجموعة من 5 ملصقات فينيل مقطوعة. جميلة، مقاومة للماء ومتينة…</p>', 'he-IL': '<p>סט של 5 מדבקות ויניל חתוכות. יפות, עמידות למים ועמידות…</p>' },
    variants: [
      { sku: 'STICKER-5PK', title: '5 Pack', price_cents: 999, weight_g: 30, stock: 200 },
    ],
  },

  // ── Bags & Carry ───────────────────────────────────────────────────────────
  {
    key: 'backpack', file: 'backpack.png', handle: 'backpack', vendor: 'Bengali Exchange',
    categories: ['bags-carry'],
    title:       { 'en-US': 'Backpack',           'fr-FR': 'Sac à dos',                'es-ES': 'Mochila',                  'zh-CN': '双肩背包',     'ar-SA': 'حقيبة ظهر',          'he-IL': 'תיק גב' },
    description: { 'en-US': 'Packaged backpack with front compartment and full-color logo print, suitable for everyday carry.', 'fr-FR': "Sac à dos emballé avec compartiment avant et marquage logo en couleur, adapté à un usage quotidien.", 'es-ES': 'Mochila empaquetada con compartimento frontal e impresión del logotipo a color, adecuada para uso diario.', 'ar-SA': 'حقيبة ظهر معبأة مع جيب أمامي وطباعة شعار بالألوان الكاملة، مناسبة للاستخدام اليومي.', 'zh-CN': '带前袋和彩色标志印刷的包装双肩背包，适合日常使用。', 'he-IL': 'תיק גב ארוז עם תא קדמי והדפסת לוגו צבעונית, מתאים לשימוש יומיומי。' },
    variants: [{ sku: 'BACKPACK', title: 'Standard', price_cents: 2990, weight_g: 700, stock: 40 }],
  },
  {
    key: 'duffle-bag', file: 'large-bag.png', handle: 'duffle-bag', vendor: 'Bengali Exchange',
    categories: ['bags-carry'],
    title:       { 'en-US': 'Duffle Bag',         'fr-FR': 'Grand sac de voyage',      'es-ES': 'Bolsa de viaje grande',    'zh-CN': '大号旅行袋',   'ar-SA': 'حقيبة سفر كبيرة',    'he-IL': 'תיק נסיעות גדול' },
    description: { 'en-US': 'Packaged duffle bag with shoulder strap, zip pockets and side logo placement.', 'fr-FR': 'Grand sac de voyage emballé avec bandoulière, poches zippées et logo sur le côté.', 'es-ES': 'Bolsa de viaje grande empaquetada con correa de hombro, bolsillos con cremallera y logotipo lateral.', 'ar-SA': 'حقيبة سفر كبيرة معبأة مع حزام كتف وجيوب بسحاب وشعار جانبي.', 'zh-CN': '带肩带、拉链口袋和侧面标志位置的包装旅行袋。', 'he-IL': 'תיק נסיעות גדול ארוז עם רצועת כתף, כיסי רוכסן ומיקום לוגו בצד。' },
    variants: [{ sku: 'LARGE_BAG', title: 'Standard', price_cents: 3990, weight_g: 900, stock: 35 }],
  },
  {
    key: 'tote-bag', file: 'tote-bag.png', handle: 'tote-bag', vendor: 'Bengali Exchange',
    categories: ['bags-carry'],
    title:       { 'en-US': 'Tote Bag',           'fr-FR': 'Tote bag',                 'es-ES': 'Bolsa tote',               'zh-CN': '帆布手提袋',   'ar-SA': 'حقيبة قماش',         'he-IL': 'תיק טוט' },
    description: { 'en-US': 'Packaged fabric tote bag with long handles and large centered logo print.', 'fr-FR': 'Tote bag en tissu emballé avec longues anses et grand logo centré.', 'es-ES': 'Bolsa tote de tela empaquetada con asas largas y gran logotipo centrado.', 'ar-SA': 'حقيبة قماش معبأة بمقابض طويلة وشعار كبير في المنتصف.', 'zh-CN': '带长提手和中央大幅标志印刷的包装布质手提袋。', 'he-IL': 'תיק טוט מבד ארוז עם ידיות ארוכות ולוגו גדול במרכז。' },
    variants: [{ sku: 'TOTE_BAG', title: 'Standard', price_cents: 1290, weight_g: 140, stock: 50 }],
  },

  // ── Drinkware ──────────────────────────────────────────────────────────────
  {
    key: 'aluminium-bottle', file: 'bottle-aluminium.png', handle: 'aluminium-bottle', vendor: 'Bengali Exchange',
    categories: ['drinkware'],
    title:       { 'en-US': 'Aluminium Bottle',   'fr-FR': 'Gourde aluminium',         'es-ES': 'Botella de aluminio',      'zh-CN': '铝制水壶',     'ar-SA': 'قارورة ألمنيوم',      'he-IL': 'בקבוק אלומיניום' },
    description: { 'en-US': 'Packaged aluminium bottle with screw cap or sports top and front logo print.', 'fr-FR': 'Gourde aluminium emballée avec bouchon vissé ou sport et logo imprimé en face avant.', 'es-ES': 'Botella de aluminio empaquetada con tapón de rosca o deportivo y logotipo impreso en la parte frontal.', 'ar-SA': 'قارورة ألمنيوم معبأة بغطاء لولبي أو رياضي مع شعار مطبوع في الواجهة الأمامية.', 'zh-CN': '带螺旋盖或运动盖并正面印有标志的包装铝制水壶。', 'he-IL': 'בקבוק אלומיניום ארוז עם פקק הברגה או ספורט ולוגו מודפס בחזית。' },
    variants: [{ sku: 'BOTTLE_ALUMINIUM', title: 'Standard', price_cents: 1990, weight_g: 320, stock: 60 }],
  },
  {
    key: 'ceramic-mug', file: 'mug.png', handle: 'ceramic-mug', vendor: 'Bengali Exchange',
    categories: ['drinkware', 'home-living'],
    title:       { 'en-US': 'Ceramic Mug',        'fr-FR': 'Mug en céramique',         'es-ES': 'Taza de cerámica',         'zh-CN': '陶瓷马克杯',   'ar-SA': 'كوب سيراميك',        'he-IL': 'ספל קרמי' },
    description: { 'en-US': 'Packaged ceramic mug with printed front logo, suitable for office or home beverage use.', 'fr-FR': "Mug en céramique emballé avec logo imprimé en face avant, adapté à un usage bureau ou maison.", 'es-ES': 'Taza de cerámica empaquetada con logotipo impreso en la parte frontal, adecuada para oficina o hogar.', 'ar-SA': 'كوب سيراميك معبأ مع شعار مطبوع في الواجهة الأمامية، مناسب للمكتب أو المنزل.', 'zh-CN': '带正面标志印刷的包装陶瓷马克杯，适合办公室或家用。', 'he-IL': 'ספל קרמי ארוז עם לוגו מודפס בחזית, מתאים למשרד או לבית。' },
    variants: [{ sku: 'MUG', title: 'Standard', price_cents: 1290, weight_g: 380, stock: 60 }],
  },

  // ── Accessories & Tech ─────────────────────────────────────────────────────
  {
    key: 'iphone-case', file: 'iphone-case.png', handle: 'iphone-17-case', vendor: 'Bengali Exchange',
    categories: ['accessories-tech'],
    title:       { 'en-US': 'iPhone 17 Case',     'fr-FR': 'Coque iPhone 17',          'es-ES': 'Funda para iPhone 17',     'zh-CN': 'iPhone 17 手机壳', 'ar-SA': 'غطاء iPhone 17',  'he-IL': 'כיסוי iPhone 17' },
    description: { 'en-US': 'Packaged protective case for iPhone 17 with centered logo print and slim everyday profile.', 'fr-FR': 'Coque de protection emballée pour iPhone 17 avec logo centré et profil fin pour un usage quotidien.', 'es-ES': 'Funda protectora empaquetada para iPhone 17 con logotipo centrado y perfil fino para uso diario.', 'ar-SA': 'غطاء حماية معبأ لهاتف iPhone 17 مع شعار في الوسط وتصميم نحيف للاستخدام اليومي.', 'zh-CN': '适用于 iPhone 17 的包装保护壳，中央带标志印刷，日常使用轻薄。', 'he-IL': 'כיסוי מגן ארוז ל‑iPhone 17 עם לוגו ממורכז ופרופיל דק לשימוש יומיומי。' },
    variants: [{ sku: 'IPHONE_CASE', title: 'Standard', price_cents: 2490, weight_g: 55, stock: 80 }],
  },
  {
    key: 'acrylic-keychain', file: 'key-holder.png', handle: 'acrylic-keychain', vendor: 'Bengali Exchange',
    categories: ['accessories-tech'],
    title:       { 'en-US': 'Acrylic Keychain',   'fr-FR': 'Porte-clés acrylique',     'es-ES': 'Llavero acrílico',         'zh-CN': '亚克力钥匙扣', 'ar-SA': 'سلسلة مفاتيح أكريليك', 'he-IL': 'מחזיק מפתחות אקרילי' },
    description: { 'en-US': 'Packaged acrylic keychain with metal ring and full-color insert featuring the product logo.', 'fr-FR': 'Porte-clés acrylique emballé avec anneau métallique et insert couleur au logo du produit.', 'es-ES': 'Llavero acrílico empaquetado con anilla metálica e inserto a color con el logotipo del producto.', 'ar-SA': 'سلسلة مفاتيح أكريليك معبأة مع حلقة معدنية وإدخال ملون يحمل شعار المنتج.', 'zh-CN': '带金属环和彩色内芯标志图案的包装亚克力钥匙扣。', 'he-IL': 'מחזיק מפתחות אקרילי ארוז עם טבעת מתכת והדפסה צבעונית של הלוגו。' },
    variants: [{ sku: 'KEY_HOLDER', title: 'Standard', price_cents: 690, weight_g: 35, stock: 120 }],
  },
  {
    key: 'lux-pen', file: 'lux-pen.png', handle: 'luxury-metal-pen', vendor: 'Bengali Exchange',
    categories: ['accessories-tech'],
    title:       { 'en-US': 'Luxury Metal Pen',   'fr-FR': 'Stylo métal premium',      'es-ES': 'Bolígrafo metálico premium', 'zh-CN': '高端金属笔', 'ar-SA': 'قلم معدني فاخر',      'he-IL': 'עט מתכת יוקרתי' },
    description: { 'en-US': 'Packaged premium metal pen with glossy finish and discreet logo branding.', 'fr-FR': 'Stylo métal premium emballé avec finition brillante et marquage logo discret.', 'es-ES': 'Bolígrafo metálico premium empaquetado con acabado brillante y marcado de logotipo discreto.', 'ar-SA': 'قلم معدني فاخر معبأ بلمسة لامعة وعلامة شعار أنيقة.', 'zh-CN': '带亮面处理和低调标志的包装高端金属笔。', 'he-IL': 'עט מתכת יוקרתי ארוז עם גימור מבריק ומיתוג לוגו עדין。' },
    variants: [{ sku: 'LUX_PEN', title: 'Standard', price_cents: 1490, weight_g: 80, stock: 100 }],
  },
  {
    key: 'mouse-pad', file: 'mouse-pad.png', handle: 'mouse-pad', vendor: 'Bengali Exchange',
    categories: ['accessories-tech'],
    title:       { 'en-US': 'Mouse Pad',          'fr-FR': 'Tapis de souris',          'es-ES': 'Alfombrilla de ratón',     'zh-CN': '鼠标垫',       'ar-SA': 'لوحة فأرة',          'he-IL': 'משטח עכבר' },
    description: { 'en-US': 'Packaged mouse pad with smooth top surface and centered full-color logo print.', 'fr-FR': 'Tapis de souris emballé avec surface supérieure lisse et logo couleur centré.', 'es-ES': 'Alfombrilla de ratón empaquetada con superficie lisa y logotipo a color centrado.', 'ar-SA': 'لوحة فأرة معبأة بسطح علوي أملس وشعار ملون في المنتصف.', 'zh-CN': '带顺滑表面和中央彩色标志印刷的包装鼠标垫。', 'he-IL': 'משטח עכבר ארוז עם משטח עליון חלק ולוגו צבעוני במרכז。' },
    variants: [{ sku: 'MOUSE_PAD', title: 'Standard', price_cents: 1290, weight_g: 140, stock: 75 }],
  },
  {
    key: 'pen-4-colors', file: 'pen-4-colors.png', handle: 'pen-4-colors', vendor: 'Bengali Exchange',
    categories: ['accessories-tech'],
    title:       { 'en-US': '4-Color Pen',        'fr-FR': 'Stylo 4 couleurs',         'es-ES': 'Bolígrafo de 4 colores',   'zh-CN': '四色圆珠笔',   'ar-SA': 'قلم بأربعة ألوان',    'he-IL': 'עט 4 צבעים' },
    description: { 'en-US': 'Packaged multi-ink pen with four writing colors and compact logo print area.', 'fr-FR': 'Stylo multi-encre emballé avec quatre couleurs d\'écriture et zone de logo compacte.', 'es-ES': 'Bolígrafo multitinta empaquetado con cuatro colores de escritura y zona compacta para logotipo.', 'ar-SA': 'قلم متعدد الأحبار معبأ بأربعة ألوان كتابة ومساحة مدمجة للشعار.', 'zh-CN': '带四种书写颜色和紧凑标志印刷区的包装多色圆珠笔。', 'he-IL': 'עט רב-דיו ארוז עם ארבעה צבעי כתיבה ואזור לוגו קומפקטי。' },
    variants: [{ sku: 'PEN_4_COLORS', title: 'Standard', price_cents: 490, weight_g: 35, stock: 150 }],
  },
  {
    key: 'badge-pins', file: 'pins.png', handle: 'badge-pins-set', vendor: 'Bengali Exchange',
    categories: ['accessories-tech'],
    title:       { 'en-US': 'Badge Pins Set',     'fr-FR': 'Lot de badges',            'es-ES': 'Lote de badges',           'zh-CN': '徽章套装',     'ar-SA': 'مجموعة شارات',       'he-IL': 'סט סיכות תג' },
    description: { 'en-US': 'Packaged set of round badge pins with logo artwork for events, giveaways and accessories.', 'fr-FR': 'Lot emballé de badges ronds avec visuel logo pour événements, giveaways et accessoires.', 'es-ES': 'Lote empaquetado de chapas redondas con arte del logotipo para eventos, regalos y accesorios.', 'ar-SA': 'مجموعة معبأة من الشارات الدائرية برسومات الشعار للفعاليات والهدايا والإكسسوارات.', 'zh-CN': '带标志图案的圆形徽章套装包装，适用于活动、赠品和配饰。', 'he-IL': 'סט ארוז של סיכות תג עגולות עם גרפיקת לוגו לאירועים, מתנות ואביזרים。' },
    variants: [{ sku: 'PINS', title: 'Standard', price_cents: 990, weight_g: 40, stock: 100 }],
  },
  {
    key: 'usb-key', file: 'usb-key.png', handle: 'usb-flash-drive', vendor: 'Bengali Exchange',
    categories: ['accessories-tech'],
    title:       { 'en-US': 'USB Flash Drive',    'fr-FR': 'Clé USB',                  'es-ES': 'Memoria USB',              'zh-CN': 'U盘',          'ar-SA': 'ذاكرة USB',           'he-IL': 'דיסק און קי' },
    description: { 'en-US': 'Packaged USB flash drive with logo print, suitable for data transfer or promotional bundles.', 'fr-FR': 'Clé USB emballée avec logo imprimé, adaptée au transfert de données ou aux bundles promotionnels.', 'es-ES': 'Memoria USB empaquetada con logotipo impreso, adecuada para transferencia de datos o packs promocionales.', 'ar-SA': 'ذاكرة USB معبأة مع شعار مطبوع، مناسبة لنقل البيانات أو الباقات الترويجية.', 'zh-CN': '带标志印刷的包装U盘，适合数据传输或促销套装。', 'he-IL': 'דיסק און קי ארוז עם לוגו מודפס, מתאים להעברת נתונים או למארזים שיווקיים。' },
    variants: [{ sku: 'USB_KEY', title: 'Standard', price_cents: 990, weight_g: 25, stock: 120 }],
  },

  // ── Home & Living ──────────────────────────────────────────────────────────
  {
    key: 'beach-towel', file: 'beach-towel.png', handle: 'beach-towel', vendor: 'Bengali Exchange',
    categories: ['home-living'],
    title:       { 'en-US': 'Beach Towel',        'fr-FR': 'Serviette de plage',       'es-ES': 'Toalla de playa',          'zh-CN': '沙滩巾',       'ar-SA': 'منشفة شاطئ',         'he-IL': 'מגבת חוף' },
    description: { 'en-US': 'Folded beach towel in retail packaging with large central logo print for leisure and travel use.', 'fr-FR': "Serviette de plage pliée en emballage retail avec grand logo centré, idéale pour les loisirs et le voyage.", 'es-ES': 'Toalla de playa plegada en embalaje retail con gran logotipo centrado, ideal para ocio y viaje.', 'ar-SA': 'منشفة شاطئ مطوية في عبوة بيع مع شعار كبير في الوسط، مناسبة للترفيه والسفر.', 'zh-CN': '零售包装折叠沙滩巾，中央大幅标志印刷，适合休闲与旅行。', 'he-IL': 'מגבת חוף מקופלת באריזת קמעונאות עם לוגו גדול במרכז, מתאימה לפנאי ולטיולים。' },
    variants: [{ sku: 'BEACH_TOWEL', title: 'Standard', price_cents: 2490, weight_g: 650, stock: 50 }],
  },
  {
    key: 'bean-bag', file: 'beanbag.png', handle: 'bean-bag', vendor: 'Bengali Exchange',
    categories: ['home-living'],
    title:       { 'en-US': 'Bean Bag',           'fr-FR': 'Pouf poire',               'es-ES': 'Puf tipo pera',            'zh-CN': '懒人沙发',     'ar-SA': 'بين باغ',             'he-IL': 'פוף' },
    description: { 'en-US': 'Packaged bean bag seat with printed upper panel, intended for indoor lounge and event spaces.', 'fr-FR': 'Pouf emballé avec panneau supérieur imprimé, destiné aux espaces lounge et événementiels.', 'es-ES': 'Puf empaquetado con panel superior impreso, destinado a zonas lounge y eventos.', 'ar-SA': 'مقعد بين باغ معبأ مع لوحة علوية مطبوعة، مناسب لمساحات الاستراحة والفعاليات.', 'zh-CN': '带印花上表面的包装懒人沙发，适用于室内休闲和活动空间。', 'he-IL': 'פוף ארוז עם חלק עליון מודפס, מיועד לחללי ישיבה ואירועים。' },
    variants: [{ sku: 'BEANBAG', title: 'Standard', price_cents: 7900, weight_g: 3500, stock: 10 }],
  },
  {
    key: 'coir-doormat', file: 'entry-carpet-hard.png', handle: 'coir-doormat', vendor: 'Bengali Exchange',
    categories: ['home-living'],
    title:       { 'en-US': 'Coir Doormat',       'fr-FR': 'Paillasson coco',          'es-ES': 'Felpudo de coco',          'zh-CN': '椰棕门垫',     'ar-SA': 'ممسحة باب من ألياف جوز الهند', 'he-IL': 'שטיח כניסה קוקוס' },
    description: { 'en-US': 'Packaged coir doormat with printed center area, made for durable entryway use.', 'fr-FR': 'Paillasson coco emballé avec zone centrale imprimée, conçu pour un usage d\'entrée durable.', 'es-ES': 'Felpudo de coco empaquetado con zona central impresa, pensado para un uso duradero en la entrada.', 'ar-SA': 'ممسحة باب من ألياف جوز الهند معبأة مع منطقة مركزية مطبوعة، مصممة للاستخدام المتين عند المدخل.', 'zh-CN': '带中央印刷区域的包装椰棕门垫，适合耐用型入口使用。', 'he-IL': 'שטיח כניסה מקוקוס ארוז עם אזור מרכזי מודפס, מיועד לשימוש עמיד בפתח הבית。' },
    variants: [{ sku: 'ENTRY_CARPET_HARD', title: 'Standard', price_cents: 2490, weight_g: 2600, stock: 15 }],
  },
  {
    key: 'entry-mat', file: 'entry-carpet.png', handle: 'entry-mat', vendor: 'Bengali Exchange',
    categories: ['home-living'],
    title:       { 'en-US': 'Entry Mat',          'fr-FR': "Tapis d'entrée",           'es-ES': 'Alfombra de entrada',      'zh-CN': '入门地垫',     'ar-SA': 'سجادة مدخل',         'he-IL': 'שטיח כניסה' },
    description: { 'en-US': 'Packaged entry mat with printed logo area and non-slip backing for indoor or covered entry use.', 'fr-FR': 'Tapis d\'entrée emballé avec zone logo imprimée et sous-couche antidérapante pour usage intérieur ou abrité.', 'es-ES': 'Alfombra de entrada empaquetada con zona de logotipo impresa y base antideslizante para interior o zonas cubiertas.', 'ar-SA': 'سجادة مدخل معبأة مع مساحة شعار مطبوعة وظهر مانع للانزلاق للاستخدام الداخلي أو في الأماكن المغطاة.', 'zh-CN': '带印刷标志区域和防滑底面的包装入门地垫，适用于室内或遮蔽入口。', 'he-IL': 'שטיח כניסה ארוז עם אזור לוגו מודפס ותחתית מונעת החלקה לשימוש פנימי או בכניסה מקורה。' },
    variants: [{ sku: 'ENTRY_CARPET', title: 'Standard', price_cents: 2990, weight_g: 1900, stock: 15 }],
  },

  // ── Niche picks (client brief) ─────────────────────────────────────────────
  // Placeholder photos: each reuses the closest existing image in ./img until
  // real product shots are added (swap `file` / `imageFile`).
  {
    key: 'jute-tote', file: 'tote-bag.png', handle: 'handwoven-jute-tote', vendor: 'Bengali Exchange',
    categories: ['eco-jute-goods', 'bags-carry'],
    title:       { 'en-US': 'Handwoven Jute Tote', 'fr-FR': 'Cabas en jute tissé main', 'es-ES': 'Bolso de yute tejido a mano', 'zh-CN': '手工编织黄麻托特包', 'ar-SA': 'حقيبة جوت منسوجة يدويًا', 'he-IL': 'תיק יוטה ארוג ביד', 'bn-BD': 'হাতে বোনা পাটের টোট ব্যাগ' },
    description: { 'en-US': '<p>Sturdy tote woven from golden Bengal jute with cotton-lined handles. Plastic-free, compostable, and big enough for a laptop.</p>', 'fr-FR': '<p>Cabas robuste tissé en jute doré du Bengale, anses doublées de coton. Sans plastique, compostable, assez grand pour un ordinateur portable.</p>', 'es-ES': '<p>Bolso resistente tejido con yute dorado de Bengala y asas forradas de algodón. Sin plástico, compostable y con espacio para un portátil.</p>', 'zh-CN': '<p>以孟加拉金色黄麻编织的结实托特包，棉质内衬提手。无塑料、可降解，可放下笔记本电脑。</p>', 'ar-SA': '<p>حقيبة متينة منسوجة من جوت البنغال الذهبي بمقابض مبطنة بالقطن. خالية من البلاستيك وقابلة للتحلل وتتسع لحاسوب محمول.</p>', 'he-IL': '<p>תיק חזק ארוג מיוטה זהובה מבנגל עם ידיות מרופדות כותנה. ללא פלסטיק, מתכלה, ומתאים למחשב נייד.</p>', 'bn-BD': '<p>বাংলার সোনালি পাটে বোনা মজবুত টোট, সুতির হাতল। প্লাস্টিকমুক্ত, পরিবেশে মিশে যায়, ল্যাপটপও ধরে।</p>' },
    variants: [{ sku: 'JUTE-TOTE-NAT', title: 'Natural', price_cents: 1890, weight_g: 320, stock: 60 }],
  },
  {
    key: 'nakshi-kantha', file: 'beach-towel.png', handle: 'nakshi-kantha-throw', vendor: 'Bengali Exchange',
    categories: ['artisan-crafts'],
    title:       { 'en-US': 'Nakshi Kantha Throw', 'fr-FR': 'Plaid Nakshi Kantha', 'es-ES': 'Manta Nakshi Kantha', 'zh-CN': '纳克希坎塔刺绣盖毯', 'ar-SA': 'غطاء نكشي كانثا', 'he-IL': 'שמיכת נקשי קנתה', 'bn-BD': 'নকশিকাঁথা' },
    description: { 'en-US': '<p>Layered cotton throw hand-stitched in the nakshi kantha tradition of rural Bengal. Each piece takes weeks and no two are the same.</p>', 'fr-FR': '<p>Plaid en coton superposé, brodé à la main selon la tradition nakshi kantha du Bengale rural. Chaque pièce demande des semaines ; aucune n’est identique.</p>', 'es-ES': '<p>Manta de algodón en capas bordada a mano según la tradición nakshi kantha de la Bengala rural. Cada pieza lleva semanas y ninguna es igual.</p>', 'zh-CN': '<p>依照孟加拉乡村纳克希坎塔传统手工缝制的多层棉毯。每件需数周完成，件件不同。</p>', 'ar-SA': '<p>غطاء قطني متعدد الطبقات مطرز يدويًا على طريقة نكشي كانثا في ريف البنغال. تستغرق كل قطعة أسابيع ولا تتشابه قطعتان.</p>', 'he-IL': '<p>שמיכת כותנה רב-שכבתית רקומה ביד במסורת נקשי קנתה של בנגל הכפרית. כל פריט לוקח שבועות ואין שניים זהים.</p>', 'bn-BD': '<p>গ্রামবাংলার নকশিকাঁথার ঐতিহ্যে হাতে সেলাই করা কয়েক স্তরের সুতির কাঁথা। প্রতিটি তৈরিতে কয়েক সপ্তাহ লাগে, কোনো দুটি এক রকম নয়।</p>' },
    variants: [{ sku: 'KANTHA-THROW', title: '150 × 220 cm', price_cents: 8900, weight_g: 1400, stock: 12 }],
  },
  {
    key: 'terracotta-mug', file: 'mug.png', handle: 'terracotta-clay-mug', vendor: 'Bengali Exchange',
    categories: ['artisan-crafts', 'drinkware'],
    title:       { 'en-US': 'Terracotta Clay Mug', 'fr-FR': 'Mug en terre cuite', 'es-ES': 'Taza de terracota', 'zh-CN': '赤陶马克杯', 'ar-SA': 'كوب من الطين المحروق', 'he-IL': 'ספל טרקוטה', 'bn-BD': 'পোড়ামাটির মগ' },
    description: { 'en-US': '<p>Wheel-thrown by potters in Bengal and glazed inside only, so the outside keeps its warm, raw clay finish.</p>', 'fr-FR': '<p>Tourné par des potiers du Bengale, émaillé à l’intérieur seulement pour garder l’aspect brut et chaleureux de l’argile.</p>', 'es-ES': '<p>Torneada por alfareros de Bengala y esmaltada solo por dentro, para conservar el acabado cálido del barro.</p>', 'zh-CN': '<p>由孟加拉陶匠拉坯制成，仅内壁上釉，外部保留温暖质朴的陶土质感。</p>', 'ar-SA': '<p>مصنوع على عجلة الفخار بأيدي خزافي البنغال ومزجج من الداخل فقط ليحتفظ الخارج بملمس الطين الدافئ.</p>', 'he-IL': '<p>עשוי על אובניים בידי קדרים בבנגל ומזוגג מבפנים בלבד, כך שהחוץ שומר על מראה החימר החם.</p>', 'bn-BD': '<p>বাংলার কুমোরদের চাকায় তৈরি, শুধু ভেতরে গ্লেজ করা, তাই বাইরে থাকে পোড়ামাটির উষ্ণ রং।</p>' },
    variants: [{ sku: 'TERRA-MUG', title: '330 ml', price_cents: 1490, weight_g: 380, stock: 40 }],
  },
  {
    key: 'rickshaw-case', file: 'iphone-case.png', handle: 'rickshaw-art-phone-case', vendor: 'Bengali Exchange',
    categories: ['tech-wearables', 'accessories-tech'],
    title:       { 'en-US': 'Rickshaw-Art Phone Case', 'fr-FR': 'Coque Rickshaw Art', 'es-ES': 'Funda Rickshaw Art', 'zh-CN': '人力车艺术手机壳', 'ar-SA': 'غطاء هاتف بفن الريكشا', 'he-IL': 'כיסוי טלפון באמנות ריקשה', 'bn-BD': 'রিকশা-আর্ট ফোন কভার' },
    description: { 'en-US': '<p>Slim, shock-absorbing case printed with the bold colours of Dhaka rickshaw art. Wireless-charging friendly.</p>', 'fr-FR': '<p>Coque fine et antichoc imprimée aux couleurs vives de l’art des rickshaws de Dacca. Compatible recharge sans fil.</p>', 'es-ES': '<p>Funda fina y antigolpes con los colores intensos del arte de los rickshaws de Daca. Compatible con carga inalámbrica.</p>', 'zh-CN': '<p>轻薄防摔手机壳，印有达卡人力车艺术的鲜艳色彩，支持无线充电。</p>', 'ar-SA': '<p>غطاء نحيف ممتص للصدمات مطبوع بألوان فن ريكشا دكا الجريئة. متوافق مع الشحن اللاسلكي.</p>', 'he-IL': '<p>כיסוי דק ובולם זעזועים בצבעים העזים של אמנות הריקשה של דאקה. תומך בטעינה אלחוטית.</p>', 'bn-BD': '<p>ঢাকার রিকশা-আর্টের উজ্জ্বল রঙে ছাপা পাতলা, ঝাঁকুনি-সহনশীল কভার। ওয়্যারলেস চার্জিং চলে।</p>' },
    variants: [{ sku: 'RICKSHAW-CASE', title: 'iPhone 17', price_cents: 1990, weight_g: 45, stock: 80 }],
  },
  {
    key: 'alpona-hoodie', file: 'hoodie-black.png', handle: 'alpona-print-hoodie', vendor: 'Bengali Exchange',
    categories: ['tech-wearables', 'hoodies'],
    title:       { 'en-US': 'Alpona Print Hoodie', 'fr-FR': 'Sweat à capuche Alpona', 'es-ES': 'Sudadera Alpona', 'zh-CN': '阿尔波纳印花连帽衫', 'ar-SA': 'هودي بنقش ألبونا', 'he-IL': 'קפוצ׳ון בהדפס אלפונה', 'bn-BD': 'আলপনা প্রিন্ট হুডি' },
    description: { 'en-US': '<p>Heavyweight organic-cotton hoodie with a gold alpona motif across the back, the floor art drawn for Pohela Boishakh.</p>', 'fr-FR': '<p>Sweat épais en coton bio avec un motif alpona doré dans le dos, l’art du sol dessiné pour Pohela Boishakh.</p>', 'es-ES': '<p>Sudadera gruesa de algodón orgánico con un motivo alpona dorado en la espalda, el arte de suelo de Pohela Boishakh.</p>', 'zh-CN': '<p>厚实有机棉连帽衫，背部印有金色阿尔波纳图案——孟加拉新年时绘制的地面艺术。</p>', 'ar-SA': '<p>هودي ثقيل من القطن العضوي بنقش ألبونا ذهبي على الظهر، فن الأرضيات المرسوم في بوهيلا بويشاخ.</p>', 'he-IL': '<p>קפוצ׳ון עבה מכותנה אורגנית עם מוטיב אלפונה זהוב בגב, אמנות הרצפה של פוהלה בוישאח.</p>', 'bn-BD': '<p>পিঠে সোনালি আলপনার নকশা সহ ভারী অর্গানিক সুতির হুডি — পহেলা বৈশাখের আলপনা থেকে অনুপ্রাণিত।</p>' },
    variants: [
      { sku: 'ALPONA-HOOD-M', title: 'Black / M', price_cents: 6490, weight_g: 560, stock: 30, imageFile: 'hoodie-black.png' },
      { sku: 'ALPONA-HOOD-L', title: 'Black / L', price_cents: 6490, weight_g: 600, stock: 25, imageFile: 'hoodie-black.png' },
    ],
  },
  {
    key: 'jamdani-tee', file: 'tee-white.png', handle: 'jamdani-pattern-tee', vendor: 'Bengali Exchange',
    categories: ['tech-wearables', 'classic-tees'],
    title:       { 'en-US': 'Jamdani Pattern Tee', 'fr-FR': 'T-shirt motif Jamdani', 'es-ES': 'Camiseta estampado Jamdani', 'zh-CN': '贾姆达尼图案T恤', 'ar-SA': 'تي شيرت بنقش جامداني', 'he-IL': 'חולצת טי בדוגמת ג׳מדאני', 'bn-BD': 'জামদানি নকশার টি-শার্ট' },
    description: { 'en-US': '<p>Soft cotton tee with a woven-look print taken from Dhaka jamdani muslin, the UNESCO-listed weaving craft.</p>', 'fr-FR': '<p>T-shirt en coton doux avec un imprimé inspiré de la mousseline jamdani de Dacca, savoir-faire inscrit à l’UNESCO.</p>', 'es-ES': '<p>Camiseta de algodón suave con un estampado inspirado en la muselina jamdani de Daca, oficio reconocido por la UNESCO.</p>', 'zh-CN': '<p>柔软棉质T恤，图案取自达卡贾姆达尼细纱——联合国教科文组织认定的织造技艺。</p>', 'ar-SA': '<p>تي شيرت قطني ناعم بطبعة مستوحاة من موسلين جامداني دكا، حرفة النسيج المدرجة لدى اليونسكو.</p>', 'he-IL': '<p>חולצת כותנה רכה עם הדפס בהשראת מוסלין ג׳מדאני מדאקה, מלאכת אריגה המוכרת על ידי אונסק״ו.</p>', 'bn-BD': '<p>ইউনেস্কো-স্বীকৃত ঢাকাই জামদানির বুননের নকশায় ছাপা নরম সুতির টি-শার্ট।</p>' },
    variants: [
      { sku: 'JAMDANI-TEE-S', title: 'White / S', price_cents: 3290, weight_g: 180, stock: 40, imageFile: 'tee-white.png' },
      { sku: 'JAMDANI-TEE-M', title: 'White / M', price_cents: 3290, weight_g: 200, stock: 50, imageFile: 'tee-white.png' },
    ],
  },

  // ── Digital Products ───────────────────────────────────────────────────────
  {
    key: 'design-template', file: 'software.png', handle: 'design-template-pack', vendor: 'SCTG',
    categories: ['digital-products'],
    title:       { 'en-US': 'Design Template Pack',  'fr-FR': 'Pack de modèles graphiques', 'es-ES': 'Pack de plantillas de diseño', 'zh-CN': '设计模板包', 'ar-SA': 'حزمة قوالب التصميم', 'he-IL': 'חבילת תבניות עיצוב' },
    description: { 'en-US': '<p>A collection of print-ready vector templates for branded merchandise. Delivered as a ZIP archive with AI, EPS and PNG formats.</p>', 'fr-FR': '<p>Collection de modèles vectoriels prêts à imprimer pour les produits de marque. Livrée sous forme d\'archive ZIP avec les formats AI, EPS et PNG.</p>', 'es-ES': '<p>Colección de plantillas vectoriales listas para imprimir para merchandising de marca. Entregadas como archivo ZIP con formatos AI, EPS y PNG.</p>', 'zh-CN': '<p>印刷就绪的品牌商品矢量模板合集，以包含 AI、EPS 和 PNG 格式的 ZIP 压缩包形式交付。</p>', 'ar-SA': '<p>مجموعة من القوالب المتجهية الجاهزة للطباعة للبضائع ذات العلامة التجارية. تُسلَّم كأرشيف ZIP بصيغ AI وEPS وPNG.</p>', 'he-IL': '<p>אוסף תבניות וקטוריות מוכנות להדפסה למוצרי מותג. מסופק כארכיון ZIP בפורמטים AI, EPS ו-PNG.</p>' },
    variants: [
      { sku: 'TEMPLATE-PACK-FULL', title: 'Full Bundle', price_cents: 4900, weight_g: 0, stock: 0, variant_type: 'digital', requires_shipping: false },
    ],
  },

  // ── AI Token Packages ──────────────────────────────────────────────────────
  {
    key: 'ai-tokens', file: 'aitokens.png', handle: 'ai-token-pack', vendor: 'SCTG',
    categories: ['ai-tokens'],
    title:       { 'en-US': 'AI Credit Pack',        'fr-FR': 'Pack de crédits IA',          'es-ES': 'Pack de créditos IA',         'zh-CN': 'AI 积分包', 'ar-SA': 'حزمة رصيد الذكاء الاصطناعي', 'he-IL': 'חבילת קרדיטים AI' },
    description: { 'en-US': '<p>Purchase AI credits to power AI features. Credits are added instantly to your account after payment.</p>', 'fr-FR': '<p>Achetez des crédits IA pour alimenter les fonctionnalités IA. Les crédits sont ajoutés instantanément à votre compte après paiement.</p>', 'es-ES': '<p>Compra créditos IA para potenciar las funciones de IA. Los créditos se añaden instantáneamente a tu cuenta tras el pago.</p>', 'zh-CN': '<p>购买 AI 积分以驱动 AI 功能。付款后积分将立即添加到您的账户。</p>', 'ar-SA': '<p>اشترِ رصيد الذكاء الاصطناعي لتشغيل ميزات الذكاء الاصطناعي. يُضاف الرصيد فوراً إلى حسابك بعد الدفع.</p>', 'he-IL': '<p>רכוש קרדיטים AI להפעלת תכונות בינה מלאכותית. הקרדיטים נוספים מיידית לחשבונך לאחר התשלום.</p>' },
    variants: [
      { sku: '100K', title: '100 000 tokens', price_cents: 990,  weight_g: 0, stock: 0, variant_type: 'ai_tokens', ai_token_units: 100000,   requires_shipping: false },
      { sku: '1M',   title: '1M tokens',      price_cents: 4990, weight_g: 0, stock: 0, variant_type: 'ai_tokens', ai_token_units: 1000000,  requires_shipping: false },
      { sku: '10M',  title: '10M tokens',     price_cents: 9990, weight_g: 0, stock: 0, variant_type: 'ai_tokens', ai_token_units: 10000000, requires_shipping: false },
    ],
  },
] as const;

type Product = typeof PRODUCT_CATALOG[number];

/**
 * Niche tags per product key (client brief). Sent as the product's `tags`
 * (comma-separated, stored per locale) on create, and patched onto products
 * that already exist so a re-run tags an older seed too.
 */
const NICHE_TAGS: Record<string, string[]> = {
  'tee':              ['streetwear', 'gen-z', 'cotton'],
  'hoodie':           ['streetwear', 'gen-z', 'cotton'],
  'cap':              ['streetwear', 'gen-z'],
  'sticker':          ['gen-z', 'laptop', 'art'],
  'backpack':         ['tech', 'everyday-carry', 'gen-z'],
  'duffle-bag':       ['travel', 'everyday-carry'],
  'tote-bag':         ['eco-friendly', 'reusable', 'cotton'],
  'aluminium-bottle': ['eco-friendly', 'reusable', 'plastic-free'],
  'ceramic-mug':      ['ceramic', 'gift'],
  'iphone-case':      ['tech', 'gen-z', 'phone'],
  'acrylic-keychain': ['gen-z', 'gift'],
  'lux-pen':          ['desk', 'gift'],
  'mouse-pad':        ['tech', 'desk', 'gen-z'],
  'pen-4-colors':     ['desk', 'student'],
  'badge-pins':       ['gen-z', 'art'],
  'usb-key':          ['tech', 'desk'],
  'beach-towel':      ['cotton', 'summer'],
  'bean-bag':         ['home', 'gen-z'],
  'coir-doormat':     ['eco-friendly', 'natural-fibre', 'home', 'handmade'],
  'entry-mat':        ['home', 'natural-fibre'],
  'jute-tote':        ['jute', 'eco-friendly', 'handmade', 'plastic-free', 'gen-z'],
  'nakshi-kantha':    ['handmade', 'artisan', 'nakshi-kantha', 'heritage', 'cotton'],
  'terracotta-mug':   ['handmade', 'artisan', 'terracotta', 'eco-friendly'],
  'rickshaw-case':    ['tech', 'gen-z', 'rickshaw-art', 'artisan'],
  'alpona-hoodie':    ['streetwear', 'gen-z', 'alpona', 'organic-cotton'],
  'jamdani-tee':      ['streetwear', 'gen-z', 'jamdani', 'heritage'],
  'design-template':  ['digital', 'design'],
  'ai-tokens':        ['digital', 'ai'],
};

/** `tags` field value: the same English tags for every locale. */
function tagsField(key: string): string | undefined {
  const tags = NICHE_TAGS[key];
  if (!tags?.length) return undefined;
  const list = tags.join(', ');
  return JSON.stringify(
    Object.fromEntries(['en-US', 'fr-FR', 'es-ES', 'zh-CN', 'ar-SA', 'he-IL', 'bn-BD'].map((l) => [l, list])),
  );
}

/**
 * Seed regions, warehouses, and shipping rates.
 *
 * This function depends on the regions and countries list being available in
 * the database and performs a full multi-zone setup:
 * - Europe (EUR)
 * - United Kingdom (GBP)
 * - North America (USD)
 * - Rest of World (EUR)
 *
 * The result includes IDs required by other seeding steps.
 */
async function seedRegions() {
  console.log('📋 Fetching existing currencies and countries...');

  // Fetch existing currencies
  const { items: currencies } = await api('/v1/regions/currencies');
  const currencyMap: Record<string, string> = {};
  for (const curr of currencies) {
    currencyMap[curr.code] = curr.id;
  }

  // Fetch all countries in one batch request (no pagination)
  const countriesResponse = await api('/v1/regions/countries/batch');
  const countryMap: Record<string, string> = {};

  for (const country of countriesResponse.items) {
    countryMap[country.code] = country.id;
  }

  // Debug: verify we have countries
  if (Object.keys(countryMap).length === 0) {
    console.error('❌ No countries found! Make sure to run init.ts first.');
    process.exit(1);
  }

  console.log(`   Found ${Object.keys(countryMap).length} countries in database`);

  // Log sample countries
  const sampleCodes = ['FR', 'GB', 'US', 'IT'];
  const missingCodes = sampleCodes.filter(code => !countryMap[code]);
  if (missingCodes.length > 0) {
    console.warn(`   ⚠️  Missing country codes: ${missingCodes.join(', ')}`);
  }

  console.log('🏢 Creating warehouses...');
  const warehouse_fr = await ensureListed('/v1/regions/warehouses', (w) => w.display_name === 'France Distribution Center', {
    display_name: 'France Distribution Center',
    address_line1: '218 route Notre Dame de la Gorge',
    city: 'Les Contamines-Montjoie',
    postal_code: '74170',
    country_code: 'FR',
    priority: 1,
  }, 'warehouse France');

  const warehouse_it = await ensureListed('/v1/regions/warehouses', (w) => w.display_name === 'Italy Distribution Center', {
    display_name: 'Italy Distribution Center',
    address_line1: '17 piazza San Marco',
    city: 'Venezia',
    postal_code: '30124',
    country_code: 'IT',
    priority: 2,
  }, 'warehouse Italy');

  console.log('💰 Seeding taxes...');
  await seedTaxes();

  console.log('📦 Creating shipping rates...');
  const shippingRate = await ensureListed('/v1/regions/shipping-rates', (r) => r.display_name === 'Standard Shipping', {
    display_name: 'Standard Shipping',
    description: 'Standard international shipping',
    min_delivery_days: 5,
    max_delivery_days: 10,
    tax_code: 'txcd_99999999',
    tax_inclusive: true,
  }, 'shipping rate Standard Shipping');

  // Add shipping rate prices (upserted per currency by the API) for each currency
  await api(`/v1/regions/shipping-rates/${shippingRate.id}/prices`, {
    currency_id: currencyMap.EUR,
    amount_cents: 999, // €9.99
  });

  await api(`/v1/regions/shipping-rates/${shippingRate.id}/prices`, {
    currency_id: currencyMap.GBP,
    amount_cents: 799, // £7.99
  });

  await api(`/v1/regions/shipping-rates/${shippingRate.id}/prices`, {
    currency_id: currencyMap.USD,
    amount_cents: 1299, // $12.99
  });

  // Country, warehouse and shipping-rate links below use INSERT OR IGNORE on the
  // server, so re-adding them is harmless.
  console.log('🗺️ Creating regions...');

  // Europe region
  const region_eu = await ensureListed('/v1/regions', (r) => r.display_name === 'Europe', {
    display_name: 'Europe',
    currency_id: currencyMap.EUR,
    is_default: true,
    tax_inclusive: true,
  }, 'region Europe');

  // Add countries to Europe
  for (const country of EUROPEAN_COUNTRIES) {
    const countryId = countryMap[country.code];
    if (!countryId) {
      console.warn(`   ⚠️  Country not found in database: ${country.code} (${country.display_name}). Skipping.`);
      continue;
    }
    await api(`/v1/regions/${region_eu.id}/countries`, {
      country_id: countryId,
    });
  }

  // Add warehouses to Europe
  await api(`/v1/regions/${region_eu.id}/warehouses`, { warehouse_id: warehouse_fr.id });
  await api(`/v1/regions/${region_eu.id}/warehouses`, { warehouse_id: warehouse_it.id });

  // Add shipping rates to Europe
  await api(`/v1/regions/${region_eu.id}/shipping-rates`, { shipping_rate_id: shippingRate.id });

  // UK region
  const region_uk = await ensureListed('/v1/regions', (r) => r.display_name === 'United Kingdom', {
    display_name: 'United Kingdom',
    currency_id: currencyMap.GBP,
    is_default: false,
    tax_inclusive: true,
  }, 'region United Kingdom');

  for (const country of UK_COUNTRIES) {
    const countryId = countryMap[country.code];
    if (!countryId) {
      console.warn(`   ⚠️  Country not found in database: ${country.code} (${country.display_name}). Skipping.`);
      continue;
    }
    await api(`/v1/regions/${region_uk.id}/countries`, {
      country_id: countryId,
    });
  }

  await api(`/v1/regions/${region_uk.id}/warehouses`, { warehouse_id: warehouse_fr.id });
  await api(`/v1/regions/${region_uk.id}/shipping-rates`, { shipping_rate_id: shippingRate.id });

  // US region
  const region_us = await ensureListed('/v1/regions', (r) => r.display_name === 'North America', {
    display_name: 'North America',
    currency_id: currencyMap.USD,
    is_default: false,
    tax_inclusive: true,
  }, 'region North America');

  for (const country of US_COUNTRIES) {
    const countryId = countryMap[country.code];
    if (!countryId) {
      console.warn(`   ⚠️  Country not found in database: ${country.code} (${country.display_name}). Skipping.`);
      continue;
    }
    await api(`/v1/regions/${region_us.id}/countries`, {
      country_id: countryId,
    });
  }

  await api(`/v1/regions/${region_us.id}/warehouses`, { warehouse_id: warehouse_it.id });
  await api(`/v1/regions/${region_us.id}/warehouses`, { warehouse_id: warehouse_fr.id });
  await api(`/v1/regions/${region_us.id}/shipping-rates`, { shipping_rate_id: shippingRate.id });

  // World region
  const region_world = await ensureListed('/v1/regions', (r) => r.display_name === 'Rest of World', {
    display_name: 'Rest of World',
    currency_id: currencyMap.EUR,
    is_default: false,
    tax_inclusive: true,
  }, 'region Rest of World');

  for (const country of OTHER_COUNTRIES) {
    const countryId = countryMap[country.code];
    if (!countryId) {
      console.warn(`   ⚠️  Country not found in database: ${country.code} (${country.display_name}). Skipping.`);
      continue;
    }
    await api(`/v1/regions/${region_world.id}/countries`, {
      country_id: countryId,
    });
  }

  await api(`/v1/regions/${region_world.id}/warehouses`, { warehouse_id: warehouse_fr.id });
  await api(`/v1/regions/${region_world.id}/shipping-rates`, { shipping_rate_id: shippingRate.id });

  return {
    warehouses: { fr: warehouse_fr.id, it: warehouse_it.id },
    regions: { eu: region_eu.id, uk: region_uk.id, us: region_us.id, world: region_world.id },
    currencyMap,
    shippingRate,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Type definitions
// ─────────────────────────────────────────────────────────────────────────────

interface SeedReview { customer_email: string; product_key: string; rating: number; title: string; body: string; status: 'approved' | 'pending'; }

// ─────────────────────────────────────────────────────────────────────────────
// Data: shipping addresses & orders for demo customers
// To add a customer / order: add an entry to SEED_ADDRESSES then SEED_ORDERS.
//
// Region -> customer_email -> address. Used for /v1/orders/test seeds.
// ─────────────────────────────────────────────────────────────────────────────

const SEED_ADDRESSES: Record<string, Record<string, any>> = {
  eu: {
    'sarah@eu.example.com':  { name: 'Sarah Dupont',   line1: '123 Rue de la Paix',        city: 'Paris',      postal_code: '75001',    country: 'FR' },
    'mike@eu.example.com':   { name: 'Mike Schmidt',   line1: '456 Hauptstrasse',           city: 'Berlin',     postal_code: '10115',    country: 'DE' },
    'emma@eu.example.com':   { name: 'Emma García',    line1: '789 Calle Principal',        city: 'Madrid',     postal_code: '28001',    country: 'ES' },
    'oliver@eu.example.com': { name: 'Oliver Rossi',   line1: '321 Via Roma',               city: 'Roma',       postal_code: '00184',    country: 'IT' },
  },
  uk: {
    'james@uk.example.com':  { name: 'James Williams', line1: '100 Oxford Street',          city: 'London',     postal_code: 'W1D 1LL',  country: 'GB', state: 'England' },
    'olivia@uk.example.com': { name: 'Olivia Brown',   line1: '50 Regent Street',           city: 'Manchester', postal_code: 'M1 1JQ',   country: 'GB', state: 'England' },
  },
  us: {
    'noah@us.example.com':   { name: 'Noah Johnson',   line1: '1600 Pennsylvania Avenue NW', city: 'Washington', postal_code: '20500',    country: 'US', state: 'DC' },
    'ava@us.example.com':    { name: 'Ava Smith',      line1: '350 5th Avenue',             city: 'New York',   postal_code: '10118',    country: 'US', state: 'NY' },
  },
};

const SEED_ORDERS: Record<string, Array<{ customer_email: string; items: Array<{ sku: string; qty: number }> }>> = {
  // One entry per region; each test order is created with default shipping rules
  eu: [
    { customer_email: 'sarah@eu.example.com',  items: [{ sku: 'TEE-BLK-M',  qty: 2 }, { sku: 'CAP-BLK',    qty: 1 }] },
    { customer_email: 'mike@eu.example.com',   items: [{ sku: 'HOOD-BLK-L', qty: 1 }] },
    { customer_email: 'emma@eu.example.com',   items: [{ sku: 'TEE-WHT-S',  qty: 1 }, { sku: 'TEE-WHT-M',  qty: 1 }, { sku: 'CAP-NVY', qty: 2 }] },
    { customer_email: 'oliver@eu.example.com', items: [{ sku: 'STICKER-5PK',qty: 3 }, { sku: 'TEE-BLK-S',  qty: 1 }] },
  ],
  uk: [
    { customer_email: 'james@uk.example.com',  items: [{ sku: 'HOOD-GRY-M', qty: 1 }, { sku: 'TEE-BLK-L',  qty: 2 }] },
    { customer_email: 'olivia@uk.example.com', items: [{ sku: 'CAP-BLK',    qty: 1 }] },
  ],
  us: [
    { customer_email: 'noah@us.example.com',   items: [{ sku: 'TEE-BLK-S',  qty: 1 }, { sku: 'TEE-WHT-L',  qty: 1 }, { sku: 'HOOD-BLK-M', qty: 1 }] },
    { customer_email: 'ava@us.example.com',    items: [{ sku: 'HOOD-GRY-L', qty: 2 }] },
  ],
};

// Customers whose orders are immediately set to 'delivered' (review eligibility)
const REVIEW_CUSTOMERS = new Set([
  'ava@us.example.com',
  'noah@us.example.com',
  'olivia@uk.example.com',
  'james@uk.example.com',
  'oliver@eu.example.com',
]);

// ─────────────────────────────────────────────────────────────────────────────
// Data: demo reviews
// status 'approved' → visible immediately · status 'pending' → awaiting moderation
// ─────────────────────────────────────────────────────────────────────────────

const SEED_REVIEWS: SeedReview[] = [
  { customer_email: 'ava@us.example.com',    product_key: 'hoodie',  rating: 5, title: 'Amazing quality!',    body: 'Love this hoodie — great fit and the logo looks fantastic.',        status: 'approved' },
  { customer_email: 'noah@us.example.com',   product_key: 'tee',     rating: 5, title: 'Perfect shirt',        body: 'Super comfortable and the print quality is excellent.',             status: 'approved' },
  { customer_email: 'noah@us.example.com',   product_key: 'hoodie',  rating: 5, title: 'Great hoodie',         body: 'Warm, stylish, and great for everyday wear.',                       status: 'approved' },
  { customer_email: 'olivia@uk.example.com', product_key: 'cap',     rating: 5, title: 'Love this cap',        body: 'Fits perfectly and looks great.',                                   status: 'approved' },
  { customer_email: 'james@uk.example.com',  product_key: 'hoodie',  rating: 5, title: 'Excellent hoodie',     body: 'Really good quality, very happy with this purchase.',               status: 'pending'  },
  { customer_email: 'james@uk.example.com',  product_key: 'tee',     rating: 5, title: 'Quality tee',          body: 'Nice and comfortable, love the logo placement.',                    status: 'pending'  },
  { customer_email: 'oliver@eu.example.com', product_key: 'sticker', rating: 5, title: 'Great stickers',       body: 'Vibrant colors and they stick really well.',                        status: 'pending'  },
  { customer_email: 'oliver@eu.example.com', product_key: 'tee',     rating: 5, title: 'Classic and comfy',    body: 'Nice and comfortable, the logo placement is perfect.',              status: 'pending'  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Seeding functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create all products from PRODUCT_CATALOG with multi-currency pricing,
 * category assignments and warehouse inventory.
 *
 * 1. Creates product metadata (titles/descriptions/translations)
 * 2. Links product to categories
 * 3. Creates variants with storage-agnostic images and prices
 * 4. Sets inventory in relevant warehouses
 *
 * @param regionData Output from seedRegions()
 * @param categoryData Output from seedCategories()
 * @returns Map of product key -> product id.
 */
async function seedProducts(regionData: any, categoryData: any): Promise<Record<string, string>> {
  const productIds: Record<string, string> = {};
  const { EUR: eurId, USD: usdId, GBP: gbpId } = regionData.currencyMap as Record<string, string>;

  const handleToId: Record<string, string> = {
    'classic-tees':     categoryData.classicTees,
    'caps':             categoryData.caps,
    'hoodies':          categoryData.hoodies,
    'stickers':         categoryData.stickers,
    'bags-carry':       categoryData.bagsCarry,
    'drinkware':        categoryData.drinkware,
    'accessories-tech': categoryData.accessoriesTech,
    'home-living':      categoryData.homeLiving,
    'eco-jute-goods':   categoryData.ecoJuteGoods,
    'tech-wearables':   categoryData.techWearables,
    'artisan-crafts':   categoryData.artisanCrafts,
    'digital-products': categoryData.digitalProducts,
    'ai-tokens':        categoryData.aiTokens,
  };

  /**
   * Prices are upserted by the API (one row per variant + currency). Stock is
   * only added to a warehouse that has no row for the SKU yet: warehouse-adjust
   * takes a delta, so re-adding would double the stock on every run.
   */
  async function seedVariantPricesAndStock(productId: string, variantId: string, v: any, stock: number) {
    const pricePath = `/v1/products/${productId}/variants/${variantId}/prices`;
    if (eurId) await api(pricePath, { currency_id: eurId, price_cents: v.price_cents });
    if (usdId) await api(pricePath, { currency_id: usdId, price_cents: convertCents(v.price_cents, EUR_TO_USD) });
    if (gbpId) await api(pricePath, { currency_id: gbpId, price_cents: convertCents(v.price_cents, EUR_TO_GBP) });

    if ((v.variant_type ?? 'physical') !== 'physical') return;

    // Special mock distribution: TEE-BLK-S is split between IT/FR warehouses
    // for regional stock testing; all other SKUs are stocked in FR.
    const targets: Array<[string, number]> = v.sku === 'TEE-BLK-S'
      ? [[regionData.warehouses.it, 10], [regionData.warehouses.fr, stock - 10]]
      : [[regionData.warehouses.fr, stock]];

    const level = await apiGetOrNull(`/v1/inventory?sku=${encodeURIComponent(v.sku)}`);
    const stocked = new Set<string>((level?.items?.[0]?.warehouses ?? []).map((w: any) => w.warehouse_id));
    for (const [warehouseId, qty] of targets) {
      if (stocked.has(warehouseId)) continue;
      await api(`/v1/inventory/${encodeURIComponent(v.sku)}/warehouse-adjust`, { warehouse_id: warehouseId, delta: qty, reason: 'restock' });
    }
  }

  // Existing products by handle, each with its variants by SKU (both UNIQUE).
  const existingProducts = new Map<string, { id: string; variants: Map<string, any> }>();
  let cursor: string | null = null;
  do {
    const page: any = await api(`/v1/products?limit=100&noimage=true${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    for (const p of page.items) {
      const entry = { id: p.id, variants: new Map<string, any>((p.variants ?? []).map((v: any) => [v.sku, v])) };
      for (const handle of handleValues(p.handle)) existingProducts.set(handle, entry);
    }
    cursor = page.pagination?.has_more ? page.pagination.next_cursor : null;
  } while (cursor);

  for (const prod of PRODUCT_CATALOG) {
    // Preserve localized vendor name for all defined locales.
    const i18nVendor = { 'en-US': prod.vendor, 'fr-FR': prod.vendor, 'es-ES': prod.vendor, 'zh-CN': prod.vendor, 'ar-SA': prod.vendor, 'he-IL': prod.vendor };

    const found = existingProducts.get(prod.handle);
    console.log(found ? `📦 ${prod.title['en-US']} (already exists)` : `📦 Creating ${prod.title['en-US']}...`);
    const tags = tagsField(prod.key);
    const product = found ?? await api('/v1/products', {
      handle: prod.handle,
      title: JSON.stringify(prod.title),
      description: JSON.stringify(prod.description),
      vendor: JSON.stringify(i18nVendor),
      ...(tags ? { tags } : {}),
    });
    if (found && tags) await apiPatch(`/v1/products/${product.id}`, { tags });
    const existingVariants: Map<string, any> = found?.variants ?? new Map();

    productIds[prod.key] = product.id;

    for (const cat of prod.categories) {
      const catId = handleToId[cat];
      if (catId) await api(`/v1/categories/${catId}/products`, { product_ids: [product.id] });
    }

    for (const v of prod.variants) {
      const { stock, imageFile, ...variantBase } = v as any;
      const existingVariant = existingVariants.get(v.sku);
      if (existingVariant) {
        console.log(`   └─ ${v.sku} (already exists)`);
        await seedVariantPricesAndStock(product.id, existingVariant.id, v, stock);
        continue;
      }

      const imgFile: string = imageFile ?? prod.file;
      const variantPayload: any = { ...variantBase, currency: 'EUR', tax_code: 'txcd_99999999' };
      const rawSrc: string = imageMap[imgFile] ?? imgFile;
      const imageUrl = await toWebpDataUri(rawSrc, 1200, 80);
      const thumbnailUrl = await toWebpDataUri(rawSrc, 400, 80);
      if (imageUrl) variantPayload.image_url = imageUrl;
      if (thumbnailUrl) variantPayload.thumbnail_url = thumbnailUrl;

      console.log(`   └─ ${v.sku}`);
      const created = await api(`/v1/products/${product.id}/variants`, variantPayload);
      await seedVariantPricesAndStock(product.id, created.id, v, stock);
    }
  }

  return productIds;
}

/**
 * Create all demo orders across regions.
 * Orders for customers in REVIEW_CUSTOMERS are immediately transitioned to
 * 'delivered' so they become review-eligible.
 *
 * This also simulates a payment session and attaches shipping metadata.
 */
async function seedOrders(regionData: any): Promise<void> {
  console.log('\n🛒 Creating test orders...');
  const shippingCentsByRegion: Record<string, number> = { eu: 999, uk: 799, us: 1299 };

  for (const [regionKey, orders] of Object.entries(SEED_ORDERS)) {
    const regionId = regionData.regions[regionKey as keyof typeof regionData.regions];
    const shippingCents = shippingCentsByRegion[regionKey] ?? 999;

    for (const order of orders) {
      // Each demo customer has exactly one order; reuse it on re-runs.
      const { items: previous } = await api(`/v1/orders?limit=1&email=${encodeURIComponent(order.customer_email)}`);
      if (previous.length > 0) {
        const existing = previous[0];
        console.log(`   ↩  [${regionKey.toUpperCase()}] ${existing.number}: ${order.customer_email} (already exists)`);
        if (REVIEW_CUSTOMERS.has(order.customer_email) && existing.status !== 'delivered') {
          await apiPatch(`/v1/orders/${existing.id}`, { status: 'delivered' });
          console.log(`      ✓ marked delivered (review-eligible)`);
        }
        continue;
      }

      const address = SEED_ADDRESSES[regionKey]?.[order.customer_email];
      const result = await api('/v1/orders/test', {
        ...order,
        region_id: regionId,
        shipping_address: address,
        shipping_rate_id: regionData.shippingRate.id,
        shipping_cents: shippingCents,
        stripe_checkout_session_id: `cs_test_${Math.random().toString(36).substring(2, 22).toUpperCase()}`,
        stripe_payment_intent_id:   `pi_test_${Math.random().toString(36).substring(2, 22).toUpperCase()}`,
      });

      const itemsSummary = order.items.map((i) => `${i.qty}x ${i.sku}`).join(', ');
      console.log(`   └─ [${regionKey.toUpperCase()}] ${result.number}: ${order.customer_email} (${itemsSummary})`);

      if (REVIEW_CUSTOMERS.has(order.customer_email)) {
        await apiPatch(`/v1/orders/${result.id}`, { status: 'delivered' });
        console.log(`      ✓ marked delivered (review-eligible)`);
      }
    }
  }
}

/**
 * Seed demo reviews via the admin seed endpoint.
 * Idempotent — skips reviews that already exist (safe for re-runs).
 *
 * @param productIds Map from product key to product id.
 */
async function seedReviews(productIds: Record<string, string>): Promise<void> {
  console.log('\n⭐ Seeding reviews...');

  for (const review of SEED_REVIEWS) {
    const productId = productIds[review.product_key];
    if (!productId) {
      console.warn(`   ⚠️  Unknown product key '${review.product_key}' — skipping review for ${review.customer_email}`);
      continue;
    }
    const result = await api('/v1/reviews/admin/seed', {
      product_id: productId,
      customer_email: review.customer_email,
      rating: review.rating,
      title: review.title,
      body: review.body,
      status: review.status,
    });

    if (result.status === 'already_exists') {
      console.log(`   ↩  ${review.customer_email} → ${review.product_key} (already exists)`);
    } else {
      const icon = review.status === 'approved' ? '✅' : '🕐';
      console.log(`   ${icon} ${review.customer_email} → ${review.product_key}: "${review.title}" [${review.status}]`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main orchestrator
// ─────────────────────────────────────────────────────────────────────────────

async function seed() {
  console.log('🌱 Seeding demo data...\n');

  if (FORCE) {
    console.log('🧹 --force: wiping demo data (currencies, countries, API keys and settings are kept)...');
    const result = await api('/v1/setup/demo-reset', {});
    console.log(`   ✅ ${result.deleted} rows deleted\n`);
  }

  // Step 1: Regions, tax, shipping, and warehouses.
  const regionData   = await seedRegions();

  // Step 2: Categories, including parent-children links.
  const categoryData = await seedCategories();

  // Step 3: Products + prices + inventory.
  const productIds = await seedProducts(regionData, categoryData);

  // Step 4: Place sample orders and mark review-eligible orders as delivered.
  await seedOrders(regionData);

  // Step 5: Seed review entries for delivered orders.
  await seedReviews(productIds);

  console.log('\n✅ Done! Demo data is in place (safe to run again).\n');

  const { items: allProducts } = await api('/v1/products?limit=100&noimage=true');
  const { items: allOrders }   = await api('/v1/orders?limit=100');
  console.log(`Products : ${allProducts.length}`);
  console.log(`Variants : ${allProducts.reduce((sum: number, p: any) => sum + p.variants.length, 0)}`);
  console.log(`Orders   : ${allOrders.length}`);
  const totalRevenue = allOrders.reduce((sum: number, o: any) => sum + o.amounts.total_cents, 0);
  console.log(`Revenue  : €${(totalRevenue / 100).toFixed(2)}`);
  console.log(`\n📊 Admin: ${API_URL}`);
}

seed().catch((err) => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});

