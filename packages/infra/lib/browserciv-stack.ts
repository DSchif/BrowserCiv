import * as path from "node:path";
import * as cdk from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ecsPatterns from "aws-cdk-lib/aws-ecs-patterns";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3 from "aws-cdk-lib/aws-s3";
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

    // Gateway endpoints — S3 and DynamoDB traffic stays on the AWS backbone,
    // never touches the NAT gateway. Free and automatic via route table entries.
    vpc.addGatewayEndpoint("S3Endpoint", {
      service: ec2.GatewayVpcEndpointAwsService.S3,
    });
    vpc.addGatewayEndpoint("DynamoDbEndpoint", {
      service: ec2.GatewayVpcEndpointAwsService.DYNAMODB,
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

    // --- Model storage ---
    const modelBucket = new s3.Bucket(this, "ModelBucket", {
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [
        // keep only last 10 versions of each model file to control storage costs
        { noncurrentVersionExpiration: cdk.Duration.days(30) },
      ],
    });

    // IAM role for EC2 spot training instances
    const trainingRole = new iam.Role(this, "TrainingRole", {
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonSSMManagedInstanceCore"),
      ],
      inlinePolicies: {
        ModelBucketAccess: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ["s3:GetObject", "s3:PutObject", "s3:HeadObject"],
              resources: [modelBucket.arnForObjects("*")],
            }),
            new iam.PolicyStatement({
              actions: ["s3:ListBucket"],
              resources: [modelBucket.bucketArn],
            }),
            // allow self-termination
            new iam.PolicyStatement({
              actions: ["ec2:TerminateInstances"],
              resources: ["*"],
              conditions: {
                StringEquals: { "ec2:ResourceTag/Project": "BrowserCiv" },
              },
            }),
          ],
        }),
      },
    });
    const trainingInstanceProfile = new iam.CfnInstanceProfile(this, "TrainingInstanceProfile", {
      roles: [trainingRole.roleName],
    });

    // Security group: only egress needed (training pulls from S3 + game server)
    const trainingSg = new ec2.SecurityGroup(this, "TrainingSg", {
      vpc,
      description: "BrowserCiv training instances",
      allowAllOutbound: true,
    });

    // Pre-baked training AMI: AL2023 + python3.11 + torch2.2+cpu + browserciv deps.
    // Avoids pip-installing torch on every training run (~5 min → ~30 sec boot).
    // Rebuild with: packages/infra/scripts/bake-training-ami.sh
    const trainingAmiId = "ami-01214ebcbe53a7838";

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
            MODEL_BUCKET: modelBucket.bucketName,
            TRAINING_AMI_ID: trainingAmiId,
            TRAINING_INSTANCE_PROFILE: trainingInstanceProfile.attrArn,
            TRAINING_SG_ID: trainingSg.securityGroupId,
            TRAINING_SUBNET_ID: vpc.privateSubnets[0]!.subnetId,
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
        // Public ALB URL — EC2 instances in the same VPC reach it via the ALB's
        // private IP (AWS resolves the same DNS name internally), so traffic
        // never leaves the VPC.
        GAME_SERVER_EXTERNAL: `http://${service.loadBalancer.loadBalancerDnsName}`,
        MODEL_BUCKET: modelBucket.bucketName,
        TRAINING_AMI_ID: trainingAmiId,
        TRAINING_INSTANCE_PROFILE: trainingInstanceProfile.attrArn,
        TRAINING_SG_ID: trainingSg.securityGroupId,
        TRAINING_SUBNET_ID: vpc.privateSubnets[0]!.subnetId,
        AWS_REGION: this.region,
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

    // Server's task role permissions
    stateTable.grantReadWriteData(service.taskDefinition.taskRole);
    jwtSecret.grantRead(service.taskDefinition.taskRole);
    modelBucket.grantReadWrite(service.taskDefinition.taskRole);

    // Allow the server task to launch/describe EC2 instances for training
    service.taskDefinition.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: [
          "ec2:RunInstances",
          "ec2:DescribeInstances",
          "ec2:CreateTags",
          "ec2:TerminateInstances",
        ],
        resources: ["*"],
      }),
    );
    service.taskDefinition.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ["iam:PassRole"],
        resources: [trainingRole.roleArn],
      }),
    );

    this.serviceUrl = `http://${service.loadBalancer.loadBalancerDnsName}`;
    new cdk.CfnOutput(this, "ServiceUrl", { value: this.serviceUrl });
    new cdk.CfnOutput(this, "StateTableName", { value: stateTable.tableName });
    new cdk.CfnOutput(this, "ModelBucketName", { value: modelBucket.bucketName });

    // Suppress an unused-var warning if elbv2 import is needed in future
    void elbv2;
  }
}
