#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer, VERSION } from "./server.js";

if (process.argv.includes("--version")) {
  console.log(VERSION);
  process.exit(0);
}

const server = createServer();
await server.connect(new StdioServerTransport());
// stdout carries the protocol, so diagnostics go to stderr.
console.error(`InkRelay MCP server ${VERSION} running on stdio`);
