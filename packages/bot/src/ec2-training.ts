/**
 * EC2 spot launch + S3 progress polling for PyTorch training runs.
 * Called by sim-server when agent type is "pytorch".
 */
import {
  EC2Client,
  RunInstancesCommand,
  DescribeInstancesCommand,
  TerminateInstancesCommand,
} from "@aws-sdk/client-ec2";
import { S3Client, GetObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";

const region = process.env.AWS_REGION ?? "us-east-1";
const ec2 = new EC2Client({ region });
const s3  = new S3Client({ region });

export interface PyTorchLaunchConfig {
  /** Public ALB URL — EC2 uses this to reach the game server (stays in VPC via ALB private IP). */
  gameServerUrl: string;
  s3Bucket: string;
  /** S3 prefix for this run, e.g. "runs/run-2026-05-07T12-00-00". */
  runPrefix: string;
  mapSize: string;
  opponentStrategy: string;
  episodes: number;
  maxTurns: number;
  stepDelayMs?: number;
  hiddenLayers?: string;
  learningRate?: number;
  /** S3 key of the agent zip to download (default: "agents/ppo-v1.zip"). */
  agentZipKey?: string;
  /** Python file inside the zip to run (default: "main.py"). */
  entrypoint?: string;
  /** Reward weights forwarded as env vars (e.g. REWARD_KILL=2.0). */
  rewardWeights?: Record<string, number>;
  /** ObsConfig feature flags for the hybrid model (serialised as OBS_CONFIG JSON). */
  obsConfig?: Record<string, boolean>;
  // Infrastructure
  amiId: string;
  instanceType?: string;
  instanceProfileArn: string;
  securityGroupId: string;
  subnetId: string;
}

export interface PyTorchRunHandle {
  instanceId: string;
  runPrefix: string;
  liveKey: string;
}

export interface PyTorchLiveState {
  episode: number;
  totalEpisodes: number;
  turn: number;
  maxTurns: number;
  reward: number;
  matchId: string | null;
  spectatorToken: string | null;
  done: boolean;
  instanceId?: string;
  agentPlayerId?: string | null;
  cumKills?: number;
  cumCaptures?: number;
}

// Fallback order: try cheaper/more-available types first when the preferred is dry.
const SPOT_INSTANCE_TYPES = [
  "c5.xlarge",
  "c5a.xlarge",
  "c5.2xlarge",
  "c5a.2xlarge",
  "m5.xlarge",
  "m5a.xlarge",
  "m6i.xlarge",
];

export async function launchPyTorchTraining(cfg: PyTorchLaunchConfig): Promise<PyTorchRunHandle> {
  const liveKey = `${cfg.runPrefix}/live.json`;
  const modelKey = `${cfg.runPrefix}/model.pt`;

  const userData = Buffer.from(buildUserData({ ...cfg, liveKey, modelKey })).toString("base64");

  const candidates = cfg.instanceType ? [cfg.instanceType, ...SPOT_INSTANCE_TYPES] : SPOT_INSTANCE_TYPES;
  let lastError: unknown;

  for (const instanceType of candidates) {
    try {
      const res = await ec2.send(new RunInstancesCommand({
        ImageId: cfg.amiId,
        InstanceType: instanceType as never,
        MinCount: 1,
        MaxCount: 1,
        IamInstanceProfile: { Arn: cfg.instanceProfileArn },
        SecurityGroupIds: [cfg.securityGroupId],
        SubnetId: cfg.subnetId,
        InstanceMarketOptions: {
          MarketType: "spot",
          SpotOptions: { SpotInstanceType: "one-time" },
        },
        UserData: userData,
        TagSpecifications: [{
          ResourceType: "instance",
          Tags: [
            { Key: "Name",       Value: "browserciv-training" },
            { Key: "Project",    Value: "BrowserCiv" },
            { Key: "RunPrefix",  Value: cfg.runPrefix },
            { Key: "InstanceType", Value: instanceType },
          ],
        }],
      }));
      const instance = res.Instances?.[0];
      if (!instance?.InstanceId) throw new Error("EC2 launch returned no instance");
      console.log(`[ec2] launched ${instanceType} instance ${instance.InstanceId}`);
      return { instanceId: instance.InstanceId, runPrefix: cfg.runPrefix, liveKey };
    } catch (err: unknown) {
      const code = (err as { Code?: string }).Code ?? (err as { code?: string }).code ?? "";
      if (code === "InsufficientInstanceCapacity" || code === "SpotMaxPriceTooLow" || String(err).includes("capacity")) {
        console.warn(`[ec2] no spot capacity for ${instanceType}, trying next…`);
        lastError = err;
        continue;
      }
      throw err;
    }
  }
  throw lastError ?? new Error("No spot capacity available for any instance type");
}

export async function getPyTorchLiveState(bucket: string, liveKey: string): Promise<PyTorchLiveState | null> {
  try {
    const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: liveKey }));
    const body = await obj.Body?.transformToString();
    if (!body) return null;
    return JSON.parse(body) as PyTorchLiveState;
  } catch {
    return null;
  }
}

export async function getS3Json(bucket: string, key: string): Promise<unknown | null> {
  try {
    const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const body = await obj.Body?.transformToString();
    return body ? JSON.parse(body) : null;
  } catch {
    return null;
  }
}

export async function terminateEc2Instance(instanceId: string): Promise<void> {
  try {
    await ec2.send(new TerminateInstancesCommand({ InstanceIds: [instanceId] }));
    console.log(`[ec2] terminated instance ${instanceId}`);
  } catch (e) {
    console.error(`[ec2] failed to terminate ${instanceId}:`, e);
  }
}

export interface RunningInstanceInfo {
  instanceId: string;
  instanceType: string;
  launchTime: string | undefined;
  runPrefix: string | null;
  liveKey: string | null;
}

export async function listRunningTrainingInstances(): Promise<RunningInstanceInfo[]> {
  try {
    const res = await ec2.send(new DescribeInstancesCommand({
      Filters: [
        { Name: "tag:Project",              Values: ["BrowserCiv"] },
        { Name: "tag:Name",                 Values: ["browserciv-training"] },
        { Name: "instance-state-name",      Values: ["pending", "running"] },
      ],
    }));
    const infos: RunningInstanceInfo[] = [];
    for (const r of res.Reservations ?? []) {
      for (const inst of r.Instances ?? []) {
        if (!inst.InstanceId) continue;
        const runPrefix = inst.Tags?.find((t) => t.Key === "RunPrefix")?.Value ?? null;
        infos.push({
          instanceId: inst.InstanceId,
          instanceType: inst.InstanceType ?? "unknown",
          launchTime: inst.LaunchTime?.toISOString(),
          runPrefix,
          liveKey: runPrefix ? `${runPrefix}/live.json` : null,
        });
      }
    }
    return infos;
  } catch { return []; }
}

export async function describeTrainingInstance(instanceId: string) {
  const res = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }));
  return res.Reservations?.[0]?.Instances?.[0] ?? null;
}

export interface S3AgentEntry {
  key: string;   // full S3 key, e.g. "agents/ppo-v1.zip"
  name: string;  // display name, e.g. "ppo-v1"
  entrypoint: string;  // python file to run, derived from zip metadata or defaulted to "main.py"
}

export async function listS3Agents(bucket: string): Promise<S3AgentEntry[]> {
  try {
    const res = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: "agents/", Delimiter: "/" }));
    return (res.Contents ?? [])
      .filter((o) => o.Key?.endsWith(".zip"))
      .map((o) => {
        const key  = o.Key!;
        const name = key.replace(/^agents\//, "").replace(/\.zip$/, "");
        return { key, name, entrypoint: "main.py" };
      });
  } catch {
    return [];
  }
}

// ── User-data script ──────────────────────────────────────────────────────────

function buildUserData(cfg: PyTorchLaunchConfig & { liveKey: string; modelKey: string }): string {
  const zipKey    = cfg.agentZipKey ?? "agents/ppo-v1.zip";
  const entrypoint = cfg.entrypoint ?? "main.py";
  return `#!/bin/bash
set -euo pipefail

# Always self-terminate on exit — even if Python crashes or set -e fires early.
_self_terminate() {
  local ID REGION
  ID=$(curl -sf http://169.254.169.254/latest/meta-data/instance-id) || return
  REGION=$(curl -sf http://169.254.169.254/latest/meta-data/placement/region) || return
  aws ec2 terminate-instances --region "$REGION" --instance-ids "$ID" || true
}
trap _self_terminate EXIT

# Download the selected agent package and run its entrypoint.
aws s3 cp s3://${cfg.s3Bucket}/${zipKey} /tmp/agent.zip
unzip -q /tmp/agent.zip -d /tmp/agent
cd /tmp/agent

export GAME_SERVER="${cfg.gameServerUrl}"
export MODEL_BUCKET="${cfg.s3Bucket}"
export MODEL_KEY="${cfg.modelKey}"
export LIVE_KEY="${cfg.liveKey}"
export EPISODES="${cfg.episodes}"
export MAX_TURNS="${cfg.maxTurns}"
export MAP_SIZE="${cfg.mapSize}"
export OPPONENT_STRATEGY="${cfg.opponentStrategy}"
${cfg.hiddenLayers  ? `export HIDDEN="${cfg.hiddenLayers}"` : ""}
${cfg.learningRate  ? `export LR="${cfg.learningRate}"` : ""}
${cfg.stepDelayMs  ? `export STEP_DELAY="${(cfg.stepDelayMs / 1000).toFixed(3)}"` : ""}
${cfg.rewardWeights ? Object.entries(cfg.rewardWeights).map(([k, v]) => `export ${k}="${v}"`).join("\n") : ""}
${cfg.obsConfig ? `export OBS_CONFIG='${JSON.stringify(cfg.obsConfig)}'` : ""}

# 4-hour hard ceiling — terminates training and then EXIT trap self-destructs.
timeout 14400 python3.11 ${entrypoint} || true
`;
}
