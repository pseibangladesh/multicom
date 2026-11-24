// Node stand-in for the `cloudflare:workers` module (aliased in vitest.config.ts).
export class DurableObject<Env = unknown> {
  constructor(public ctx: any, public env: Env) {}
}
