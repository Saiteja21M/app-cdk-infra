import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";

import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as rds from "aws-cdk-lib/aws-rds";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as route53_targets from "aws-cdk-lib/aws-route53-targets";
import * as iam from "aws-cdk-lib/aws-iam";
import { Credentials } from "aws-cdk-lib/aws-rds";

export class AppCdkInfraStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const secretKey = new rds.DatabaseSecret(this, "AppDBSecretKey", {
      secretName: "db-credentials",
      username: "postgres",
    });

    // VPC with public and private subnets
    const vpc = new ec2.Vpc(this, "AppVpc", {
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: "public",
          subnetType: ec2.SubnetType.PUBLIC,
        },
        {
          cidrMask: 24,
          name: "private",
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        },
      ],
    });

    // Aurora RDS (PostgreSQL)
    const dbSg = new ec2.SecurityGroup(this, "DbSg", {
      vpc,
      description: "DB SG",
      allowAllOutbound: true,
    });
    dbSg.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(5432),
      "Allow traffic to DB from anywhere"
    );

    const credentials = Credentials.fromSecret(secretKey);

    const dbCluster = new rds.DatabaseCluster(this, "AppAurora", {
      engine: rds.DatabaseClusterEngine.auroraPostgres({
        version: rds.AuroraPostgresEngineVersion.VER_13_18,
      }),
      credentials: credentials,
      port: 5432,
      instanceProps: {
        vpc,
        vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
        securityGroups: [dbSg],
        instanceType: ec2.InstanceType.of(
          ec2.InstanceClass.R5,
          ec2.InstanceSize.LARGE
        ),
        publiclyAccessible: true,
      },
      instances: 1,
      defaultDatabaseName: "postgres",
    });
    // ECS Cluster
    const cluster = new ecs.Cluster(this, "AppCluster", {
      vpc,
      clusterName: "AppCluster",
    });

    // ECS Task Execution Role for pulling ECR images
    const executionRole = new iam.Role(this, "AppTaskExecutionRole", {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          "service-role/AmazonECSTaskExecutionRolePolicy"
        ),
      ],
    });

    // Security Groups
    const lbSg = new ec2.SecurityGroup(this, "LbSg", {
      vpc,
      description: "LB SG",
      allowAllOutbound: true,
    });
    lbSg.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(80),
      "Allow HTTP from anywhere"
    );
    lbSg.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
      "Allow HTTPS from anywhere"
    );

        // Task Definition
    const taskDef = new ecs.FargateTaskDefinition(this, 'AppTaskDef', {
      memoryLimitMiB: 512,
      cpu: 256,
      executionRole,
    });

    const ecsSg = new ec2.SecurityGroup(this, "EcsSg", {
      vpc,
      description: "ECS SG",
      allowAllOutbound: true,
    });
    ecsSg.addIngressRule(lbSg, ec2.Port.tcp(80), "Allow traffic from LB");

    // Add ECS container with DB env vars after dbCluster is defined
    const container = taskDef.addContainer("AppContainer", {
      image: ecs.ContainerImage.fromRegistry(
        "751236674196.dkr.ecr.eu-central-1.amazonaws.com/new-app-with-db"
      ),
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: "AppContainer" }),
      portMappings: [{ containerPort: 8080 }],
      environment: {
        DB_NAME: "postgres",
        DB_PORT: dbCluster.clusterEndpoint.port.toString(),
        DB_HOST: dbCluster.clusterEndpoint.hostname,
      },
      secrets: {
        DB_USERNAME: ecs.Secret.fromSecretsManager(secretKey, 'username'),
        DB_PASSWORD: ecs.Secret.fromSecretsManager(secretKey, 'password'),
      },
    });

    // Application Load Balancer
    const lb = new elbv2.ApplicationLoadBalancer(this, "AppALB", {
      vpc,
      internetFacing: true,
      securityGroup: lbSg,
      loadBalancerName: "AppALB",
    });
    const listener = lb.addListener("HttpListener", {
      port: 80,
      open: true,
    });

    // ECS Service
    const service = new ecs.FargateService(this, "AppService", {
      cluster,
      taskDefinition: taskDef,
      desiredCount: 1,
      assignPublicIp: true,
      securityGroups: [ecsSg],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    });
    listener.addTargets("EcsTargets", {
      port: 8080,
      targets: [service],
      healthCheck: {
        path: "/hello",
        healthyHttpCodes: "200",
      },
    });

    // Route53 Zone and Records
    const zone = route53.HostedZone.fromLookup(this, "CloudSaiZone", {
      domainName: "cloud-sai.com",
    });
    new route53.ARecord(this, "BackendAliasRecord", {
      zone,
      recordName: "be.cloud-sai.com",
      target: route53.RecordTarget.fromAlias(
        new route53_targets.LoadBalancerTarget(lb)
      ),
    });
  }
}
