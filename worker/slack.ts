import { SlackAPI } from "https://deno.land/x/deno_slack_api@2.1.1/mod.ts";

import { call } from "./functions.ts";

export const client = async () => {
  const token: string = (await call("hiphops.slack.accesstoken")) as string;
  console.log("Creating client");
  const c = await _client(token);
  console.log("Got client internally");
  return c;
};

export const _client = async (token: string) => {
  console.log("Internally getting client");
  return SlackAPI(token);
};
