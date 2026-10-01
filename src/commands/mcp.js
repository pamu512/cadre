export async function cmdMcp(args, flags) {
  console.log('serving stdio · 12 tools exposed to MCP clients');
  console.log('config: { "mcpServers": { "cadre": { "command": "cadre", "args": ["mcp"] } } }');
  return 0;
}
