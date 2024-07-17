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

    const uiPorts = [{ portMappingName: "yelb-ui", port: 80 }]

    const yelbUiTaskDefinition = this.buildTaskDefinition("yelb-ui", "mreferre/yelb-ui:0.10", uiPorts);

    const yelbuiservice = new ecs_patterns.ApplicationLoadBalancedFargateService(this, "yelb-ui-service", {
      cluster: ecsCluster, 
      desiredCount: 2, 
      publicLoadBalancer: true, 
      serviceName: "yelb-ui",
      taskDefinition: yelbUiTaskDefinition,
      enableExecuteCommand: true
    });

    // Have to do this separate because ApplicationLoadBalancedFargateService doesn't support service connect
    yelbuiservice.service.enableServiceConnect({
      namespace: dnsNamespace.namespaceName,
    })

    yelbuiservice.node.addDependency(dnsNamespace)

    const appPorts = [{ portMappingName: "yelb-appserver", port: 4567 }]

    const yelbAppServerTaskDefinition = this.buildTaskDefinition("yelb-appserver", "mreferre/yelb-appserver:0.7", appPorts);

    const yelbappserverservice = new ecs.FargateService(this, "yelb-appserver-service", {
      cluster: ecsCluster, 
      desiredCount: 2, 
      serviceName: "yelb-appserver",
      taskDefinition: yelbAppServerTaskDefinition,
      serviceConnectConfiguration: {
        services: appPorts.map(({ portMappingName, port }) => ({
          portMappingName,
          dnsName: portMappingName,
          port,
        })),
        namespace: dnsNamespace.namespaceName,
      },
      enableExecuteCommand: true
    });

    yelbappserverservice.connections.allowFrom(yelbuiservice.service, ec2.Port.tcp(4567))

    yelbappserverservice.node.addDependency(dnsNamespace)

    const dbPorts = [{ portMappingName: "yelb-db", port: 5432 }]
    
    const yelbDbTaskDefinition = this.buildTaskDefinition("yelb-db", "mreferre/yelb-db:0.6", dbPorts);

    const yelbdbservice = new ecs.FargateService(this, "yelb-db-service", {
      cluster: ecsCluster,
      serviceName: "yelb-db",
      taskDefinition: yelbDbTaskDefinition,
      // Comment the "serviceConnectConfiguration" block out if you wish to experiment setting this up manually through the AWS Console
      // If manually setting up, make sure you disable Service Connect log configuration (under advanced) 
      // as the generated execution role doesn't have permission to create log groups, so the deployment will get stuck in a crash loop
      serviceConnectConfiguration: {
        services: dbPorts.map(({ portMappingName, port }) => ({
          portMappingName,
          dnsName: portMappingName,
          port,
        })),
        namespace: dnsNamespace.namespaceName,
      },
      enableExecuteCommand: true
    });

    yelbdbservice.connections.allowFrom(yelbappserverservice, ec2.Port.tcp(5432))

    yelbdbservice.node.addDependency(dnsNamespace)

    const redisPorts = [{ portMappingName: "redis-server", port: 6379 }]

    const redisTaskDefinition = this.buildTaskDefinition("redis", "redis:4.0.2", redisPorts);

    const redisserverservice = new ecs.FargateService(this, "redis-server-service", {
      cluster: ecsCluster, 
      serviceName: "redis-server",
      taskDefinition: redisTaskDefinition,
      serviceConnectConfiguration: {
        services: redisPorts.map(({ portMappingName, port }) => ({
          portMappingName,
          dnsName: portMappingName,
          port,
        })),
        namespace: dnsNamespace.namespaceName,
      },
      enableExecuteCommand: true
    });

    redisserverservice.connections.allowFrom(yelbappserverservice, ec2.Port.tcp(6379))

    redisserverservice.node.addDependency(dnsNamespace)
  }

  buildTaskDefinition = (appName: string, dockerImage: string, portMappings: { portMappingName: string, port: number }[]) => {

    const taskdef = new ecs.FargateTaskDefinition(this, `${appName}-taskdef`, {
      memoryLimitMiB: 2048, 
      cpu: 512, 
    });

    const container = taskdef.addContainer(`${appName}`, {
      image: ecs.ContainerImage.fromRegistry(dockerImage),
      logging: ecs.LogDrivers.awsLogs({ 
        logGroup: this.logGroup,
        streamPrefix: `service`
      })
    })

    portMappings.forEach(({ port, portMappingName }) =>
      container.addPortMappings({ containerPort: port, name: portMappingName})
    );

    taskdef.executionRole?.addManagedPolicy(cdk.aws_iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AmazonECSTaskExecutionRolePolicy"))

    return taskdef
  }
}
