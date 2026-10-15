import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { createKV } from "./kv.mjs";
import { seed } from "./seed.mjs";
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
export function localEdge() {
  return {
    name: "orbit-local-edge",
    hooks: {
      "astro:config:setup": ({ command, updateConfig }) => {
        if (command !== "dev") return;
        updateConfig({
          vite: {
            plugins: [
              {
                name: "orbit-api",
                async configureServer(server) {
                  const kv = await createKV(
                    new URL("../.local/kv.json", import.meta.url).pathname,
                  );
                  await seed(kv);
                  server.middlewares.use(async (req, res, next) => {
                    if (!req.url?.startsWith("/api/")) return next();
                    try {
                      const url = `http://${req.headers.host}${req.url}`;
                      const body = ["GET", "HEAD"].includes(req.method)
                        ? undefined
                        : Readable.toWeb(req);
                      const request = new Request(url, {
                        method: req.method,
                        headers: req.headers,
                        body,
                        ...(body ? { duplex: "half" } : {}),
                      });
                      const source = await readFile(
                        new URL("../quant/edge-functions/api.js", import.meta.url),
                        "utf8",
                      );
                      const response = await new AsyncFunction(
                        "event",
                        "kvStore",
                        source,
                      )(
                        { request, quantOrg: "local", quantProject: "dev" },
                        kv,
                      );
                      res.statusCode = response.status;
                      response.headers.forEach((value, key) =>
                        res.setHeader(key, value),
                      );
                      res.end(Buffer.from(await response.arrayBuffer()));
                    } catch (error) {
                      console.error(error);
                      res.statusCode = 503;
                      res.end('{"error":"Local API unavailable."}');
                    }
                  });
                },
              },
            ],
          },
        });
      },
    },
  };
}
