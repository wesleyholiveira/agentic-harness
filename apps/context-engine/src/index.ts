#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createContextEngineServer } from "./server";

const transport = new StdioServerTransport();
const server = createContextEngineServer();
void server.connect(transport);
