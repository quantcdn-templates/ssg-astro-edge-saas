import { digest } from "./kv.mjs";
export const localKey = "0123456789abcdef".repeat(4);
export const localStore = "local-dev-orbit";
export async function seed(kv) {
  if (await kv.get(localStore, "seed:v1")) return;
  await kv.set(localStore, `auth:${digest(localKey)}`, {
    name: "Alex Morgan",
    workspace: "studio",
    role: "owner",
    active: true,
  });
  await kv.set(localStore, "workspace:studio:settings", {
    name: "Studio workspace",
    description: "A little space for our next big thing.",
  });
  const examples = [
    [
      "Website refresh",
      "A thoughtful new home for our brand.",
      "Alex Morgan",
      "active",
      "high",
      72,
      6,
    ],
    [
      "Customer onboarding",
      "Make every first impression count.",
      "Jamie Chen",
      "active",
      "high",
      48,
      12,
    ],
    [
      "Autumn campaign",
      "Bring our next collection into the world.",
      "Sam Rivera",
      "active",
      "medium",
      85,
      3,
    ],
    [
      "Design system",
      "One shared language for everything we build.",
      "Alex Morgan",
      "active",
      "medium",
      36,
      18,
    ],
    [
      "Mobile experience",
      "Explore a simpler way to work on the go.",
      "Taylor Brooks",
      "planned",
      "medium",
      10,
      30,
    ],
    [
      "Customer interviews",
      "Listen closely. Learn something new.",
      "Jamie Chen",
      "complete",
      "low",
      100,
      -2,
    ],
    [
      "Brand guidelines",
      "The details that make us, us.",
      "Sam Rivera",
      "complete",
      "medium",
      100,
      -5,
    ],
    [
      "Partner programme",
      "Make room for new possibilities.",
      "Taylor Brooks",
      "planned",
      "low",
      0,
      40,
    ],
  ];
  for (const [
    i,
    [name, description, owner, status, priority, progress, days],
  ] of examples.entries()) {
    const id = (i + 1).toString(16).padStart(32, "0");
    await kv.set(localStore, `workspace:studio:project:${id}`, {
      id,
      name,
      description,
      owner,
      status,
      priority,
      progress,
      due: new Date(Date.now() + days * 86400000).toISOString().slice(0, 10),
      createdAt: new Date(Date.now() - 14 * 86400000).toISOString(),
      updatedAt: new Date(Date.now() - i * 3600000).toISOString(),
      updatedBy: owner,
    });
  }
  await kv.set(localStore, "seed:v1", true);
}
