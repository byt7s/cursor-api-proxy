import * as http from "node:http";

import { buildAccountsReport } from "../../cli/accounts.js";
import { json } from "../http.js";

/** GET /accounts — JSON account list (same data as `cursor-api-proxy accounts`). */
export function handleAccounts(res: http.ServerResponse): void {
  void buildAccountsReport()
    .then((report) => json(res, 200, report))
    .catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      json(res, 500, {
        error: { message: msg, code: "accounts_list_failed" },
      });
    });
}
