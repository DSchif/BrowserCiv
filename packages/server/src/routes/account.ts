import bcrypt from "bcryptjs";
import type { FastifyInstance } from "fastify";
import { nanoid } from "nanoid";
import { getUser, saveUser, type UserRecord } from "../account-store.js";

// Comma-separated list of usernames that are always treated as admin.
// Useful for bootstrapping the first admin without touching the DB.
const ADMIN_USERS = new Set(
  (process.env.ADMIN_USERS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
);

function isAdminUser(username: string, record?: UserRecord | null): boolean {
  return ADMIN_USERS.has(username.toLowerCase()) || record?.isAdmin === true;
}

export async function registerAccountRoutes(app: FastifyInstance): Promise<void> {
  app.post("/account/register", async (req, reply) => {
    const { username, password } = (req.body ?? {}) as Record<string, unknown>;
    if (typeof username !== "string" || username.trim().length < 2)
      return reply.code(400).send({ error: "INVALID_USERNAME" });
    if (typeof password !== "string" || password.length < 6)
      return reply.code(400).send({ error: "PASSWORD_TOO_SHORT" });

    const key = username.trim();
    if (await getUser(key)) return reply.code(409).send({ error: "USERNAME_TAKEN" });

    const admin = ADMIN_USERS.has(key.toLowerCase());
    const user: UserRecord = {
      userId: nanoid(16),
      username: key,
      passwordHash: await bcrypt.hash(password, 10),
      createdAt: new Date().toISOString(),
      ...(admin ? { isAdmin: true } : {}),
    };
    await saveUser(user);

    const token = app.jwt.sign(
      { userId: user.userId, username: user.username, isAdmin: admin },
      { expiresIn: "30d" },
    );
    return reply.send({ token, username: user.username });
  });

  app.post("/account/login", async (req, reply) => {
    const { username, password } = (req.body ?? {}) as Record<string, unknown>;
    if (typeof username !== "string" || typeof password !== "string")
      return reply.code(400).send({ error: "BAD_REQUEST" });

    const user = await getUser(username);
    if (!user || !(await bcrypt.compare(password, user.passwordHash)))
      return reply.code(401).send({ error: "INVALID_CREDENTIALS" });

    const admin = isAdminUser(user.username, user);
    // Persist admin flag if it came from the env var and wasn't already saved.
    if (admin && !user.isAdmin) {
      await saveUser({ ...user, isAdmin: true });
    }

    const token = app.jwt.sign(
      { userId: user.userId, username: user.username, isAdmin: admin },
      { expiresIn: "30d" },
    );
    return reply.send({ token, username: user.username });
  });

  app.get("/account/me", { onRequest: [app.authenticate] }, async (req) => {
    return { user: req.user };
  });
}
