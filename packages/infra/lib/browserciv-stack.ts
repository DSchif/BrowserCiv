import * as path from "node:path";
import * as cdk from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ecsPatterns from "aws-cdk-lib/aws-ecs-patterns";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { Construct } from "constructs";

/**
 * One-stack BrowserCiv deployment:
 *  - VPC (2 AZs, 1 NAT)
 *  - DynamoDB StateTable (single-table for matches + tokens)
 *  - Fargate task running the bundled server+SPA, fronted by an ALB
 *
 * Persistent resources (DynamoDB) are RETAIN — destroying the stack does
 * not nuke saved games. Re-creating gets a fresh table.
 */
export class BrowserCivStack extends cdk.Stack {
  public readonly serviceUrl: string;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    cdk.Tags.of(this).add("Project", "BrowserCiv");

    // --- Network ---
    const vpc = new ec2.Vpc(this, "Vpc", {
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        { name: "public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        {
          name: "private",
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: 24,
        },
      ],
    });

    // --- Secrets ---
    const jwtSecret = new secretsmanager.Secret(this, "JwtSecret", {
      secretName: "browserciv/jwt-secret",
      generateSecretString: {
        passwordLength: 64,
        excludePunctuation: true,
      },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // --- Persistence ---
    const stateTable = new dynamodb.Table(this, "StateTable", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // --- Compute ---
    const cluster = new ecs.Cluster(this, "Cluster", {
      vpc,
      containerInsights: true,
    });

    // CDK builds the image from the repo root Dockerfile and pushes it to
    // the bootstrap-managed ECR. Path is relative to this file.
    const repoRoot = path.resolve(__dirname, "..", "..", "..");

    const service = new ecsPatterns.ApplicationLoadBalancedFargateService(
      this,
      "GameService",
      {
        cluster,
        cpu: 1024,
        memoryLimitMiB: 2048,
        desiredCount: 1,
        publicLoadBalancer: true,
        taskImageOptions: {
          image: ecs.ContainerImage.fromAsset(repoRoot),
          containerPort: 8787,
          environment: {
            PORT: "8787",
            HOST: "0.0.0.0",
            STATE_TABLE: stateTable.tableName,
            AWS_REGION: this.region,
            SIM_SERVER_URL: "http://localhost:3334",
          },
          secrets: {
            JWT_SECRET: ecs.Secret.fromSecretsManager(jwtSecret),
          },
        },
      },
    );

    // Sim-server sidecar — same image, different command, not load-balanced.
    // The game server proxies /sim/* /agents/* /runs/* to localhost:3334.
    service.taskDefinition.addContainer("SimServer", {
      image: ecs.ContainerImage.fromAsset(repoRoot),
      command: ["pnpm", "--filter", "@browserciv/bot", "run", "sim-server", "--", "--no-spawn"],
      portMappings: [{ containerPort: 3334 }],
      environment: {
        PORT: "3334",
        HOST: "0.0.0.0",
        GAME_SERVER_URL: "http://localhost:8787",
      },
      logging: new ecs.AwsLogDriver({ streamPrefix: "sim-server" }),
    });

    // ALB health check hits /health (server returns {status:"ok"}).
    service.targetGroup.configureHealthCheck({
      path: "/health",
      healthyHttpCodes: "200",
      interval: cdk.Duration.seconds(30),
      healthyThresholdCount: 2,
      unhealthyThresholdCount: 3,
    });

    // WebSocket connections hold open — extend ALB idle timeout from default
    // 60s so /ws sockets aren't dropped between turns.
    service.loadBalancer.setAttribute(
      "idle_timeout.timeout_seconds",
      "300",
    );

    // Server's task role can read/write the state table and read the JWT secret.
    stateTable.grantReadWriteData(service.taskDefinition.taskRole);
    jwtSecret.grantRead(service.taskDefinition.taskRole);

    this.serviceUrl = `http://${service.loadBalancer.loadBalancerDnsName}`;
    new cdk.CfnOutput(this, "ServiceUrl", { value: this.serviceUrl });
    new cdk.CfnOutput(this, "StateTableName", { value: stateTable.tableName });

    // Suppress an unused-var warning if elbv2 import is needed in future
    void elbv2;
  }
}
