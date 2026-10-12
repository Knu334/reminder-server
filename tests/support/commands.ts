import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

/** Replace only SDK transport: real command objects and adapter code still execute. */
export function captureCommands(replies: unknown[]): { client: DynamoDBDocumentClient; sent: unknown[] } {
  const sent: unknown[] = [];
  const client = {
    send(command: unknown): Promise<unknown> {
      sent.push(command);
      if (sent.length > replies.length) return Promise.reject(new Error("Unexpected SDK send"));
      const reply = replies[sent.length - 1];
      return reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply);
    },
  } as unknown as DynamoDBDocumentClient;
  return { client, sent };
}
