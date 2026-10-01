import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
const { QUANT_CUSTOMER, QUANT_PROJECT } = process.env;
if (!QUANT_CUSTOMER || !QUANT_PROJECT)
  throw new Error(
    "Set QUANT_CUSTOMER and QUANT_PROJECT before preparing deployment.",
  );
const manifest = JSON.parse(await readFile("edge-functions.json", "utf8"));
// Stable per project, so repeated deploys update the same function. A new
// template instance in another project receives a different function ID.
for (const entry of manifest) {
  const hex = createHash("sha256")
    .update(JSON.stringify([QUANT_CUSTOMER, QUANT_PROJECT, entry.id]))
    .digest("hex");
  entry.uuid ??= `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
await writeFile(
  ".quant-functions.json",
  JSON.stringify(manifest, null, 2) + "\n",
);
