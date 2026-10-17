import assert from "node:assert/strict";
import { test } from "node:test";
import { HttpRequest } from "@smithy/core/protocols";
import { createHarness } from "../../support/stateful-store";
import { testBudget } from "../../support/fixtures";
import { createFaultTransport } from "./fault-transport.ts";
import { wireFakes } from "./wire-fakes.ts";

class BinaryBody extends Uint8Array {
  override valueOf(): this {
    throw new Error("Request body must not be coerced to a string");
  }
  override toString(): string {
    throw new Error("Request body must not be coerced to a string");
  }
}

function slicedBody(input: string | Uint8Array): BinaryBody {
  const data = typeof input === "string" ? Buffer.from(input) : input;
  const padded = new Uint8Array(data.byteLength + 8);
  padded.fill(255);
  padded.set(data, 3);
  return new BinaryBody(padded.buffer, 3, data.byteLength);
}

const item = {
  ownerId: { S: "synthetic-owner" },
  id: { S: "synthetic-item" },
  title: { S: "日本語" },
};
const dynamoRequest = (operation: string, body: Uint8Array): HttpRequest =>
  new HttpRequest({
    protocol: "https:",
    hostname: "dynamodb.ap-northeast-1.amazonaws.com",
    method: "POST",
    path: "/",
    headers: { "x-amz-target": `DynamoDB_20120810.${operation}` },
    body,
  });

void test("wire fake decodes a sliced binary JSON body without string coercion", async () => {
  const harness = createHarness();
  const fakes = wireFakes(harness);
  const result = await fakes.dynamodb.handle(
    dynamoRequest("PutItem", slicedBody(JSON.stringify({ TableName: "reminders", Item: item }))),
  );
  assert.equal(result.response.statusCode, 200);
  assert.deepEqual(harness.snapshot().reminders, [
    { ownerId: "synthetic-owner", id: "synthetic-item", title: "日本語" },
  ]);
});

void test("fault transport hashes the token from sliced binary transaction JSON without string coercion", async () => {
  const harness = createHarness();
  const transport = createFaultTransport(wireFakes(harness).dynamodb, []);
  const result = await transport.handler.handle(
    dynamoRequest(
      "TransactWriteItems",
      slicedBody(
        JSON.stringify({
          ClientRequestToken: "synthetic-token",
          TransactItems: [{ Put: { TableName: "reminders", Item: item } }],
        }),
      ),
    ),
  );
  assert.equal(result.response.statusCode, 200);
  assert.deepEqual(transport.tokens, ["f06e194de9d2ad49"]);
  assert.deepEqual(harness.snapshot().reminders, [
    { ownerId: "synthetic-owner", id: "synthetic-item", title: "日本語" },
  ]);
});

void test("wire fake preserves arbitrary bytes and slice boundaries when storing a binary body", async () => {
  const harness = createHarness();
  const fakes = wireFakes(harness);
  const body = slicedBody(new Uint8Array([0, 255, 128, 1]));
  const result = await fakes.s3.handle(
    new HttpRequest({
      protocol: "https:",
      hostname: "s3.ap-northeast-1.amazonaws.com",
      method: "PUT",
      path: "/synthetic/synthetic-key",
      headers: { "content-type": "application/octet-stream" },
      body,
    }),
  );
  assert.equal(result.response.statusCode, 200);
  body.fill(0);
  const stored = await harness.images.get(
    {
      imageId: "synthetic-key",
      key: "synthetic-key",
      versionId: result.response.headers["x-amz-version-id"]!,
      mime: "application/octet-stream",
      bytes: 4,
      sha256: "",
    },
    testBudget(),
  );
  assert.deepEqual([...stored], [0, 255, 128, 1]);
});
