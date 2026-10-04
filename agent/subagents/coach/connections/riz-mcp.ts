import { defineMcpClientConnection } from "eve/connections";

import { rizMcpConnection } from "#lib/riz-mcp.js";

export default defineMcpClientConnection(rizMcpConnection);
