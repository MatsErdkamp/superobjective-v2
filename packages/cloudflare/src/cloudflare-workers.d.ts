declare module "cloudflare:workers" {
  export class WorkerEntrypoint<Env = unknown, Props = unknown> {
    constructor(ctx?: unknown, env?: Env);
    ctx: {
      props?: Props;
      exports?: Record<string, unknown>;
    };
    env: Env;
  }

  export class DurableObject<Env = unknown> {
    constructor(ctx: unknown, env: Env);
    ctx: {
      storage: {
        sql: {
          exec(query: string, ...bindings: unknown[]): {
            toArray(): Array<Record<string, unknown>>;
          };
        };
        put?(key: string, value: unknown): Promise<void>;
        get?(key: string): Promise<unknown>;
      };
      blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
    };
    env: Env;
  }
}
