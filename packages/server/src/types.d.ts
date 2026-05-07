import type { preHandlerAsyncHookHandler } from "fastify";

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: { userId: string; username: string };
    user: { userId: string; username: string };
  }
}

declare module "fastify" {
  interface FastifyInstance {
    authenticate: preHandlerAsyncHookHandler;
  }
}
