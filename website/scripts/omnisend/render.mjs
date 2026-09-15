// Usage: node scripts/omnisend/render.mjs <asset>   (e.g. layouts:header, template:welcome-1)
import { header, footer } from "./layouts.mjs";

const registry = {
  "layouts:header": header,
  "layouts:footer": footer,
};

async function main() {
  const [name] = process.argv.slice(2);
  let entry = registry[name];
  if (!entry && name?.startsWith("template:")) {
    const mod = await import("./templates.mjs");
    entry = () => mod.TEMPLATES[name.slice("template:".length)]();
  }
  if (!entry && name?.startsWith("automation:")) {
    const mod = await import("./automations.mjs");
    entry = () => mod.AUTOMATIONS[name.slice("automation:".length)]();
  }
  if (!entry) {
    console.error(`Unknown asset: ${name}. Known: ${Object.keys(registry).join(", ")}, template:<key>, automation:<key>`);
    process.exit(1);
  }
  process.stdout.write(JSON.stringify(await entry()));
}

main();
