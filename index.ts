#!/usr/bin/env -S npx tsx
// Thin stdio entry point. All tool logic lives in server.ts.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

const server = createServer();
const transport = new StdioServerTransport();
await server.connect(transport);
