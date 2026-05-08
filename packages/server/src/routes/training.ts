import type { FastifyInstance } from "fastify";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { launchTrainingInstance, describeInstance } from "../ec2-launcher.js";

const s3 = new S3Client({ region: process.env.AWS_REGION ?? "us-east-1" });

interface TrainBody {
  matchToken: string;
  viewerId: string;
  s3Key?: string;
  episodes?: number;
  maxTurns?: number;
}

export async function registerTrainingRoutes(app: FastifyInstance) {
  const bucket = process.env.MODEL_BUCKET;
  const amiId = process.env.TRAINING_AMI_ID;
  const instanceProfileArn = process.env.TRAINING_INSTANCE_PROFILE;
  const securityGroupId = process.env.TRAINING_SG_ID;
  const subnetId = process.env.TRAINING_SUBNET_ID;
  const gameServer = process.env.GAME_SERVER_EXTERNAL ?? `http://localhost:${process.env.PORT ?? 8787}`;

  // POST /train/ec2 — launch a spot training run
  app.post<{ Body: TrainBody }>(
    "/train/ec2",
    { preHandler: [app.authenticate] },
    async (req, reply) => {
      if (!bucket || !amiId || !instanceProfileArn || !securityGroupId || !subnetId) {
        return reply.code(503).send({ error: "Training infrastructure not configured" });
      }
      const { matchToken, viewerId, s3Key = "model.pt", episodes = 1000, maxTurns = 500 } = req.body;
      if (!matchToken || !viewerId) {
        return reply.code(400).send({ error: "matchToken and viewerId are required" });
      }
      try {
        const run = await launchTrainingInstance({
          amiId,
          instanceProfileArn,
          securityGroupId,
          subnetId,
          s3Bucket: bucket,
          s3Key,
          gameServer,
          matchToken,
          viewerId,
          episodes,
          maxTurns,
        });
        return reply.code(202).send(run);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return reply.code(500).send({ error: msg });
      }
    },
  );

  // GET /train/ec2/:runId/progress — fetch progress JSON from S3
  app.get<{ Params: { runId: string }; Querystring: { key?: string } }>(
    "/train/ec2/:runId/progress",
    { preHandler: [app.authenticate] },
    async (req, reply) => {
      if (!bucket) return reply.code(503).send({ error: "No model bucket" });
      const s3Key = (req.query.key ?? "model.pt") + ".progress.json";
      try {
        const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: s3Key }));
        const body = await obj.Body?.transformToString();
        return reply.code(200).type("application/json").send(body ?? "{}");
      } catch {
        return reply.code(404).send({ error: "Progress not found" });
      }
    },
  );

  // GET /train/ec2/:runId/instance — describe the EC2 instance
  app.get<{ Params: { runId: string } }>(
    "/train/ec2/:runId/instance",
    { preHandler: [app.authenticate] },
    async (req, reply) => {
      try {
        const inst = await describeInstance(req.params.runId);
        if (!inst) return reply.code(404).send({ error: "Instance not found" });
        return reply.send({
          instanceId: inst.InstanceId,
          state: inst.State?.Name,
          launchTime: inst.LaunchTime,
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return reply.code(500).send({ error: msg });
      }
    },
  );
}
