import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";
const pages = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "src/content/pages" }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    eyebrow: z.string().default("Orbit"),
    ctaLabel: z.string().default("Open your workspace"),
    ctaHref: z
      .string()
      .regex(/^\/(?!\/)[^\\]*$/)
      .default("/app"),
    draft: z.boolean().default(false),
  }),
});
export const collections = { pages };
