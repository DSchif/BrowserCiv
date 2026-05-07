import type { preHandlerAsyncHookHandler } from "fastify";

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: { userId: string; email: string; username: string };
    user: { userId: string; email: string; username: string };
  }
}

declare module "fastify" {
  interface FastifyInstance {
    authenticate: preHandlerAsyncHookHandler;
  }
}
