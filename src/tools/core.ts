/**
 * Core tool surface — assembles the per-concept tool groups into the one
 * registerCoreTools entry the server calls. Registration order is stable:
 * orient → act → sight → input → system.
 */
import type { McpServer } from '@modelcontextprotocol/server';
import type { ServerDeps } from '../index.js';
import { registerStateTools } from './state-tools.js';
import { registerWindowTools } from './window-tools.js';
import { registerScreenshotTools } from './screenshot-tools.js';
import { registerOcrTools } from './ocr-tools.js';
import { registerInputTools } from './input-tools.js';
import { registerSystemTools } from './system-tools.js';
import { gatedRegister } from './guard.js';

export function registerCoreTools(server: McpServer, deps: ServerDeps): void {
  registerStateTools(server, deps, gatedRegister);
  registerWindowTools(server, deps, gatedRegister);
  registerScreenshotTools(server, deps, gatedRegister);
  registerOcrTools(server, deps, gatedRegister);
  registerInputTools(server, deps, gatedRegister);
  registerSystemTools(server, deps, gatedRegister);
}
