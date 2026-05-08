import {
  EC2Client,
  RunInstancesCommand,
  DescribeInstancesCommand,
} from "@aws-sdk/client-ec2";

const ec2 = new EC2Client({ region: process.env.AWS_REGION ?? "us-east-1" });

export interface LaunchConfig {
  amiId: string;
  instanceType?: string;
  instanceProfileArn: string;
  securityGroupId: string;
  subnetId: string;
  s3Bucket: string;
  s3Key: string;
  gameServer: string;
  matchToken: string;
  viewerId: string;
  episodes: number;
  maxTurns: number;
}

export interface RunInfo {
  runId: string;
  instanceId: string;
  launchedAt: string;
}

export async function launchTrainingInstance(cfg: LaunchConfig): Promise<RunInfo> {
  const userData = Buffer.from(buildUserData(cfg)).toString("base64");

  const res = await ec2.send(
    new RunInstancesCommand({
      ImageId: cfg.amiId,
      InstanceType: (cfg.instanceType ?? "c5.2xlarge") as never,
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
      TagSpecifications: [
        {
          ResourceType: "instance",
          Tags: [
            { Key: "Name", Value: "browserciv-training" },
            { Key: "Project", Value: "BrowserCiv" },
          ],
        },
      ],
    }),
  );

  const instance = res.Instances?.[0];
  if (!instance?.InstanceId) throw new Error("EC2 launch returned no instance");

  return {
    runId: instance.InstanceId,
    instanceId: instance.InstanceId,
    launchedAt: new Date().toISOString(),
  };
}

export async function describeInstance(instanceId: string) {
  const res = await ec2.send(
    new DescribeInstancesCommand({ InstanceIds: [instanceId] }),
  );
  return res.Reservations?.[0]?.Instances?.[0] ?? null;
}

function buildUserData(cfg: LaunchConfig): string {
  // AL2023-compatible bootstrap: download agent zip, train, self-terminate.
  return `#!/bin/bash
set -euo pipefail
yum install -y python3.11 python3.11-pip unzip aws-cli 2>/dev/null || true
pip3.11 install --quiet boto3

# Download the packaged agent
aws s3 cp s3://${cfg.s3Bucket}/agent-py.zip /tmp/agent-py.zip
unzip -q /tmp/agent-py.zip -d /tmp/agent-py
cd /tmp/agent-py

pip3.11 install --quiet -r requirements.txt

export GAME_SERVER="${cfg.gameServer}"
export MATCH_TOKEN="${cfg.matchToken}"
export VIEWER_ID="${cfg.viewerId}"
export MODEL_BUCKET="${cfg.s3Bucket}"
export MODEL_KEY="${cfg.s3Key}"
export EPISODES="${cfg.episodes}"
export MAX_TURNS="${cfg.maxTurns}"

python3.11 train_main.py

# Self-terminate when done
INSTANCE_ID=$(curl -s http://169.254.169.254/latest/meta-data/instance-id)
REGION=$(curl -s http://169.254.169.254/latest/meta-data/placement/region)
aws ec2 terminate-instances --region "$REGION" --instance-ids "$INSTANCE_ID"
`;
}
