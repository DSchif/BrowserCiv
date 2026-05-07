import type { preHandlerAsyncHookHandler } from "fastify";

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: { userId: string; username: string; isAdmin?: boolean };
    user: { userId: string; username: string; isAdmin?: boolean };
  }
}

declare module "fastify" {
  interface FastifyInstance {
    authenticate: preHandlerAsyncHookHandler;
  }
}
