import bcrypt from "bcryptjs";
import type { FastifyInstance } from "fastify";
import { nanoid } from "nanoid";
import { getUser, saveUser, type UserRecord } from "../account-store.js";

export async function registerAccountRoutes(app: FastifyInstance): Promise<void> {
  app.post("/account/register", async (req, reply) => {
    const { username, password } = (req.body ?? {}) as Record<string, unknown>;
    if (typeof username !== "string" || username.trim().length < 2)
      return reply.code(400).send({ error: "INVALID_USERNAME" });
    if (typeof password !== "string" || password.length < 6)
      return reply.code(400).send({ error: "PASSWORD_TOO_SHORT" });

    const key = username.trim();
    if (await getUser(key)) return reply.code(409).send({ error: "USERNAME_TAKEN" });

    const user: UserRecord = {
      userId: nanoid(16),
      username: key,
      passwordHash: await bcrypt.hash(password, 10),
      createdAt: new Date().toISOString(),
    };
    await saveUser(user);

    const token = app.jwt.sign(
      { userId: user.userId, username: user.username },
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

    const token = app.jwt.sign(
      { userId: user.userId, username: user.username },
      { expiresIn: "30d" },
    );
    return reply.send({ token, username: user.username });
  });

  app.get("/account/me", { onRequest: [app.authenticate] }, async (req) => {
    return { user: req.user };
  });
}
