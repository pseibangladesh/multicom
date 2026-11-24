/**
 * Copyright (c) 2026 Ronan LE MEILLAT - SCTG Development
 * License: AGPL-3.0-or-later
 */
import type { Topic } from '../base.js';
import { BASE_SYSTEM, appendFacts } from '../base.js';

const topic: Topic = {
  name: 'use-secured-api',
  description: 'useSecuredApi React hook for authenticated calls — getJson, postJson, putJson, patchJson, deleteJson, postForm (session cookie included), plus the isAdmin hint.',
  tags: ["frontend","react","ui"],
  sources: [
    'apps/client/src/features/auth/components/auth-components.tsx',
  ],
  systemPrompt: BASE_SYSTEM,
  manualFacts: [
    'Import path: import { useSecuredApi } from "@/authentication";',
    'useSecuredApi() wraps useAuth(). Requests go with credentials: "include", so the Better Auth session cookie is sent; the storefront pk_ key is added as the Bearer token. There are no access tokens on the client.',
    'Use getJson(url) for authenticated GET requests that return JSON.',
    'Use postJson(url, body) for authenticated POST requests with a JSON body.',
    'Use putJson(url, body) for authenticated PUT (full replace) requests.',
    'Use patchJson(url, body) for authenticated PATCH (partial update) requests.',
    'Use deleteJson(url) for authenticated DELETE requests.',
    'Use postForm(url, formData) for authenticated multipart/form-data POST (e.g. image upload).',
    'isAdmin (boolean) is true when the session email is in ADMIN_EMAILS. Use it only to hide admin-only UI (AI helpers, test mail); the API checks admin access itself.',
    'Errors are thrown as Error("HTTP <status>: <server message>").',
    'For unauthenticated public endpoints (e.g. product listing), use plain fetch() or a custom hook with useQuery — do NOT use useSecuredApi() for public routes.',
    'The AI-assisted features (review moderation, auto-translation) use getJson on GET /v1/ai/parameters to obtain { apiKey, model, url } then call ai-client.ts helpers directly from the browser — no backend inference call.',
  ],
  buildPrompt: (src) => appendFacts(`
Below is the auth-components.tsx file that contains the useSecuredApi() hook.

${src}

Task: Write a "useSecuredApi() Hook Reference" for frontend developers.
Include:
1. Import path.
2. Return values table: method | signature | when to use.
   Cover: getJson, postJson, putJson, patchJson, deleteJson, postForm, isAdmin.
3. How the session cookie is sent (no tokens on the client).
4. Three complete usage examples in React components (one GET, one POST, one DELETE).
5. isAdmin example: hide an admin-only UI element.
6. When NOT to use this hook (public routes).
`, topic.manualFacts),
};

export default topic;
