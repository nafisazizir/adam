import { defineMcpClientConnection } from "eve/connections";

import { notionConnection } from "#lib/notion.js";

export default defineMcpClientConnection(notionConnection);
