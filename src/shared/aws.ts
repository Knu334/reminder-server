import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { CloudWatchClient } from "@aws-sdk/client-cloudwatch";
import type { Config } from "../config";

export interface AwsClients { dynamo: DynamoDBDocumentClient; s3: S3Client; cloudWatch: CloudWatchClient }
const environments = new Map<string, AwsClients>();

/** SDK transport retries are disabled; adapters own their bounded, budget-aware attempts. */
export function createAwsClients(config: Config): AwsClients {
  const existing = environments.get(config.region);
  if (existing) return existing;
  const settings = { region: config.region, maxAttempts: 1 };
  const clients = {
    dynamo: DynamoDBDocumentClient.from(new DynamoDBClient(settings)),
    s3: new S3Client(settings),
    cloudWatch: new CloudWatchClient(settings),
  };
  environments.set(config.region, clients);
  return clients;
}
