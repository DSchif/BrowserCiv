import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { allMatches, deleteMatch } from "../match-store.js";
import { listUsers, setUserAdmin } from "../account-store.js";
import { deleteMatchPersisted } from "../persistence.js";

async function requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    await request.jwtVerify();
  } catch {
    return reply.code(401).send({ error: "UNAUTHORIZED" });
  }
  if (!request.user.isAdmin) {
    return reply.code(403).send({ error: "FORBIDDEN" });
  }
}

export async function registerAdminRoutes(app: FastifyInstance): Promise<void> {
  app.get("/admin/users", { onRequest: [requireAdmin] }, async () => {
    const users = await listUsers();
    return {
      users: users.map(({ passwordHash: _h, ...rest }) => rest),
    };
  });

  app.post<{ Params: { username: string } }>(
    "/admin/users/:username/set-admin",
    { onRequest: [requireAdmin] },
    async (req, reply) => {
      const { isAdmin } = (req.body ?? {}) as { isAdmin?: boolean };
      if (typeof isAdmin !== "boolean")
        return reply.code(400).send({ error: "BAD_REQUEST" });
      await setUserAdmin(req.params.username, isAdmin);
      return { ok: true };
    },
  );

  app.get("/admin/matches", { onRequest: [requireAdmin] }, async () => {
    return {
      matches: allMatches().map((rt) => ({
        ...rt.summary(),
        mapSize: rt.state.mapSize,
      })),
    };
  });

  app.delete<{ Params: { id: string } }>(
    "/admin/matches/:id",
    { onRequest: [requireAdmin] },
    async (req, reply) => {
      deleteMatch(req.params.id);
      await deleteMatchPersisted(req.params.id);
      return { ok: true };
    },
  );
}
