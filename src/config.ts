import { isIP } from "node:net";

export interface Config {
  region: string;
  remindersTable: string;
  ownerStateTable: string;
  imageJobsTable: string;
  imagesBucket: string;
  expectedApiId: string;
  expectedStage: string;
  issuer: string;
  clientId: string;
  sourceIps: string[];
  limits: { jsonBytes: number; thumbnailBytes: number; itemCount: number; imageBytes: number; ownerRequestsPerMinute: number };
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  function required(name: string): string {
    const value = env[name];
    if (!value || value.trim() !== value) throw new Error(`Invalid configuration: ${name}`);
    return value;
  }
  function positiveInteger(name: string, fallback: number): number {
    const value = env[name];
    if (value === undefined) return fallback;
    if (!/^[0-9]+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1) {
      throw new Error(`Invalid configuration: ${name}`);
    }
    return Number(value);
  }
  let sourceIps: string[] = [];
  if (env.ALLOWED_SOURCE_IPS !== undefined) {
    let value: unknown;
    try { value = JSON.parse(env.ALLOWED_SOURCE_IPS); }
    catch { throw new Error("Invalid configuration: ALLOWED_SOURCE_IPS"); }
    if (!Array.isArray(value) || !value.every((ip: unknown) => typeof ip === "string" && isIP(ip) !== 0)) {
      throw new Error("Invalid configuration: ALLOWED_SOURCE_IPS");
    }
    sourceIps = value as string[];
  }
  return {
    region: required("AWS_REGION"), remindersTable: required("REMINDERS_TABLE"),
    ownerStateTable: required("OWNER_STATE_TABLE"), imageJobsTable: required("IMAGE_JOBS_TABLE"),
    imagesBucket: required("IMAGES_BUCKET"), expectedApiId: required("EXPECTED_API_ID"),
    expectedStage: required("EXPECTED_API_STAGE"), issuer: required("COGNITO_ISSUER"), clientId: required("COGNITO_CLIENT_ID"),
    sourceIps,
    limits: {
      jsonBytes: positiveInteger("MAX_JSON_BYTES", 2_097_152),
      thumbnailBytes: positiveInteger("MAX_THUMBNAIL_BYTES", 1_048_576),
      itemCount: positiveInteger("MAX_OWNER_ITEMS", 1000),
      imageBytes: positiveInteger("MAX_OWNER_IMAGE_BYTES", 134_217_728),
      ownerRequestsPerMinute: positiveInteger("OWNER_REQUESTS_PER_MINUTE", 120),
    },
  };
}
