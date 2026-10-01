import { randomBytes } from "node:crypto";
import { digest } from "./kv.mjs";
const [workspace, name, role = "owner"] = process.argv.slice(2);
if (
  !/^[a-z0-9][a-z0-9-]{0,47}$/.test(workspace || "") ||
  !name ||
  name.length > 60 ||
  !["owner", "viewer"].includes(role)
) {
  console.error(
    'Usage: npm run provision -- <workspace-slug> "Full name" [owner|viewer]',
  );
  process.exit(1);
}
const accessKey = randomBytes(32).toString("hex");
console.log(
  JSON.stringify(
    {
      accessKey,
      key: `auth:${digest(accessKey)}`,
      value: { workspace, name, role, active: true },
    },
    null,
    2,
  ),
);
