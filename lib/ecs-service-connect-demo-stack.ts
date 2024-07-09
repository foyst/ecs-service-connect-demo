import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as servicediscovery from "aws-cdk-lib/aws-servicediscovery";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ecs_patterns from "aws-cdk-lib/aws-ecs-patterns";
import { RetentionDays } from 'aws-cdk-lib/aws-logs';

export class EcsServiceConnectDemoStack extends cdk.Stack {

  readonly logGroup: cdk.aws_logs.LogGroup;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const vpc = new ec2.Vpc(this, "Vpc", {});

    const ecsCluster = new ecs.Cluster(this, "EcsCluster", {
      vpc: vpc,
      clusterName: "yelb-cluster",
    });

    const dnsNamespace = new servicediscovery.PrivateDnsNamespace(
      this,
      "DnsNamespace",
      {
        name: "yelb-service-connect.test",
        vpc: vpc,
      }
    );

    this.logGroup = new cdk.aws_logs.LogGroup(this, `LogGroup`, {
      logGroupName: "ECSServiceConnectDemo",
      removalPolicy: cdk.RemovalPolicy.DESTROY, 
      retention: RetentionDays.ONE_WEEK
    })

    const { taskdef: yelbUiTaskDefinition,
      container: yelbUiContainer
    } = this.buildTaskDefinition("yelb-ui", "mreferre/yelb-ui:0.10", dnsNamespace);

    yelbUiContainer.addPortMappings({
      containerPort: 80
    });

    const yelbuiservice = new ecs_patterns.ApplicationLoadBalancedFargateService(this, "yelb-ui-service", {
      cluster: ecsCluster, // Required
      desiredCount: 3, // Default is 1
      publicLoadBalancer: true, // Default is false
      serviceName: "yelb-ui",
      taskDefinition: yelbUiTaskDefinition,
      cloudMapOptions: { name: "yelb-ui", cloudMapNamespace: dnsNamespace },
      enableExecuteCommand: true
    });

    const { taskdef: yelbAppServerTaskDefinition } = this.buildTaskDefinition("yelb-appserver", "mreferre/yelb-appserver:0.7", dnsNamespace);

    const yelbappserverservice = new ecs.FargateService(this, "yelb-appserver-service", {
      cluster: ecsCluster, // Required
      desiredCount: 2, // Default is 1
      serviceName: "yelb-appserver",
      taskDefinition: yelbAppServerTaskDefinition,
      cloudMapOptions: { name: "yelb-appserver", cloudMapNamespace: dnsNamespace },
      enableExecuteCommand: true
    });

    yelbappserverservice.connections.allowFrom(yelbuiservice.service, ec2.Port.tcp(4567))
    
    const { taskdef: yelbDbTaskDefinition } = this.buildTaskDefinition("yelb-db", "mreferre/yelb-db:0.6", dnsNamespace);

    const yelbdbservice = new ecs.FargateService(this, "yelb-db-service", {
      cluster: ecsCluster, // Required
      serviceName: "yelb-db",
      taskDefinition: yelbDbTaskDefinition,
      cloudMapOptions: { name: "yelb-db", cloudMapNamespace: dnsNamespace },
      enableExecuteCommand: true
    });

    yelbdbservice.connections.allowFrom(yelbappserverservice, ec2.Port.tcp(5432))

    const { taskdef: redisTaskDefinition } = this.buildTaskDefinition("redis", "redis:4.0.2", dnsNamespace);

    const redisserverservice = new ecs.FargateService(this, "redis-server-service", {
      cluster: ecsCluster, // Required
      serviceName: "redis-server",
      taskDefinition: redisTaskDefinition,
      cloudMapOptions: { name: "redis-server", cloudMapNamespace: dnsNamespace },
      enableExecuteCommand: true
    });

    redisserverservice.connections.allowFrom(yelbappserverservice, ec2.Port.tcp(6379))
  }

  buildTaskDefinition = (appName: string, dockerImage: string, dnsNamespace: servicediscovery.PrivateDnsNamespace) => {

    const taskdef = new ecs.FargateTaskDefinition(this, `${appName}-taskdef`, {
      memoryLimitMiB: 2048, // Default is 512
      cpu: 512, // Default is 256
    });

    const container = taskdef.addContainer(`${appName}`, {
      image: ecs.ContainerImage.fromRegistry(dockerImage),
      logging: ecs.LogDrivers.awsLogs({ 
        logGroup: this.logGroup,
        streamPrefix: `service`
      }),
      environment: { "SEARCH_DOMAIN": dnsNamespace.namespaceName },
    })

    return { taskdef, container };
  }
}
