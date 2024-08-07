import * as path from "jsr:@std/path";

import * as nats from "https://deno.land/x/nats@v1.25.0/src/mod.ts";
import * as Comlink from "https://unpkg.com/comlink@4.4.1/dist/esm/comlink.mjs";
import { StringCodec } from "https://deno.land/x/nats@v1.25.0/nats-base-client/codec.ts";

import { WorkerMap } from "./load.ts";
import { cleanup } from "./workspace.ts";
import { config } from "./config.ts";
import type { Store, ObjectInfo } from "../run/store.ts";

type callServiceFunc = (subject: string, payload?: unknown) => Promise<unknown>;

export interface NATSClient {
  nc: nats.NatsConnection;
  js: nats.JetStreamClient;
  os: nats.ObjectStore;
}

export const closeNatsClient = async (client: NATSClient) => {
  const err = await client.nc.closed();
  if (err) {
    throw err;
  }
};

export const createNATSClient = async (
  servers: string | string[]
): Promise<NATSClient> => {
  const nc = await nats.connect({
    servers,
    reconnect: true,
    reconnectTimeWait: 1000,
    reconnectJitter: 1000,
    maxReconnectAttempts: 10,
  });
  const js = nc.jetstream();
  const os = await js.views.os("default", { storage: nats.StorageType.File });

  return { nc, js, os };
};

export const getConsumer = async (
  client: NATSClient,
  stream: string,
  consumer: string
) => {
  return await client.js.consumers.get(stream, consumer);
};

export const consume = async (
  consumer: nats.Consumer,
  callback: (msg: nats.JsMsg) => Promise<void>
) => {
  const messages = await consumer.consume();
  for await (const m of messages) {
    try {
      await callback(m);
      await m.ackAck();
    } catch (err) {
      // TODO: Add proper logging
      console.log(`Error handling message: ${err}`);
      m.nak(1000 * 60);
    }
  }
};

/** handleWork consumes messages from NATS and executes the appropriate user code */
export const handleWork = async (client: NATSClient, workerMap: WorkerMap) => {
  const consumer = await getConsumer(client, "work", "work");

  await consume(consumer, async (m: nats.JsMsg) => {
    let workerTopic: string;
    let data: unknown;

    console.log("Received message");

    try {
      ({ workerTopic, data } = decodeMessage(m));
    } catch (err) {
      return m.term(`unable to parse message data and/or topic: ${err}`);
    }

    // Get the path via the subject on workerMap
    // Trigger appropriate worker
    // TODO: Test non-existent worker
    const workerPath = workerMap[workerTopic];
    if (!workerPath) {
      return m.term("no matching worker found for message");
    }

    m.working();

    try {
      await runWorker(client, workerPath, data, m.subject);
    } catch (err) {
      console.log(`failed to complete work: ${err}`);
      m.nak(1000 * 30); // Try again in 30 seconds
    } finally {
      await cleanup();
    }

    // TODO:
    // We should consider what behaviour is desired when a message is received
    // and execution begins, but the server is killed before completion (e.g. what will happen on any deploys)
    // Thoughts: Might be best to always re-issue non completed messages (i.e. nak them),
    // then offer mechanisms within JS to wrap things in idempotency guards

    await m.ackAck();
  });
};

const decodeMessage = (msg: nats.JsMsg): { workerTopic: string; data: any } => {
  const tokens = msg.subject.split(".");
  // subject will be in form: work.sequence_id.FLOW_NAME.WORKER_NAME
  const workerTopic = tokens.slice(2).join(".");

  const msgData = new TextDecoder().decode(msg.data);
  const data = JSON.parse(msgData);

  return {
    workerTopic,
    data,
  };
};

const runWorker = async (
  client: NATSClient,
  workerPath: string,
  data: unknown,
  subject: string
) => {
  const codeDir = path.dirname(workerPath);
  const workspaceDir = path.join(config.workspacesDir, subject);

  let worker: Worker;
  try {
    worker = new Worker(import.meta.resolve(workerPath), {
      type: "module",
      deno: {
        permissions: {
          sys: ["hostname"],
          hrtime: true,
          env: "inherit",
          net: "inherit",
          read: [codeDir, workspaceDir],
          write: [workspaceDir],
        },
      },
    });
  } catch (err) {
    console.log("Failed to start worker:", err);
    return;
  }

  const serviceCallProxy = Comlink.proxy(natsCaller(client));
  const storeProxy = Comlink.proxy(hiphopsStore(client));
  const run = Comlink.wrap(worker);
  const timeoutID = setTimeout(() => {
    console.log("Timeout reached, cancelling worker");
    run[Comlink.releaseProxy]();
    worker.terminate();
    console.log("Worker cancelled");
  }, 1000 * config.workerTimeout);

  try {
    const result = await run({ data, subject }, serviceCallProxy, storeProxy, {
      workspaceDir,
      codeDir,
    });
    // This could still be a failure/partial failure, depending on the result object
    console.log("Worker run completed:", JSON.stringify(result));
  } catch (err) {
    console.log("Worker run failed:", err);
  } finally {
    console.log("Cleaning up worker");
    clearTimeout(timeoutID);
    run[Comlink.releaseProxy]();
    worker.terminate();
    console.log("Terminated");
  }
};

const natsCaller = (client: NATSClient): callServiceFunc => {
  const codec = nats.JSONCodec();

  // TODO: Catch NATS 503 errors and make them friendlier to end users
  // Ideally shouldn't just dump a stack trace, but should say "This is why" (no such connection)
  return async (subject: string, data?: unknown) => {
    let payload: Uint8Array | undefined = undefined;
    if (data) {
      payload = codec.encode(data);
    }

    const msg = await client.nc.request(subject, payload);
    return codec.decode(msg.data);
  };
};

const hiphopsStore = (client: NATSClient): Store => {
  // store = client.os;
  const stringCodec = StringCodec();

  const del = async (name: string): Promise<boolean> => {
    const purgeResult = await client.os.delete(name);

    return purgeResult.success;
  };

  const get = async (name: string): Promise<string | null> => {
    const content = await client.os.getBlob(name);
    if (content == null) return null;

    return stringCodec.decode(content);
  };

  const put = async (
    name: string,
    value: string,
    description?: string
  ): Promise<ObjectInfo> => {
    const objInfo = await client.os.putBlob(
      { name, description },
      stringCodec.encode(value)
    );

    return {
      revision: objInfo.revision,
      digest: objInfo.digest,
      size: objInfo.size,
    };
  };

  return { delete: del, get, put };
};
