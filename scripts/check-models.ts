/** Run: bun run check. Asserts the models.yml subset that feeds the model picker. */
import { parseOmpModels } from "../lib/herdr/models";

const CONFIG = `# comment with a colon: ignored
providers:
  agentrouter:
    baseUrl: https://agentrouter.org
    apiKey: AGENTROUTER_API_KEY
    models:
      - id: deepseek-v4-flash
        name: DeepSeek V4 Flash
      - id: glm-5.3
  ccs:
    models:
      - id: cc-deepseek-v4.1-flash
`;

let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) console.log(`ok   ${name}`);
  else {
    failures += 1;
    console.error(`FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
};

const models = parseOmpModels(CONFIG);
check("bare ids are offered", models.includes("deepseek-v4-flash") && models.includes("glm-5.3"));
check("ids are provider-qualified", models.includes("agentrouter/deepseek-v4-flash") && models.includes("ccs/cc-deepseek-v4.1-flash"));
check("the `providers:` wrapper is not a provider", !models.some((model) => model.startsWith("providers/")), models);
check("the `models:` container is not a provider", !models.some((model) => model.startsWith("models/")), models);
check("a second provider switches the prefix", models.includes("ccs/glm-5.3") === false, models);
check("no config shape known → nothing invented", parseOmpModels("version: 3\n") .length === 0);
check("a key with a value is not a provider", !parseOmpModels("other: x\nmodels:\n  - id: solo\n").some((model) => model.includes("/")), parseOmpModels("other: x\nmodels:\n  - id: solo\n"));

console.log(`\n${failures === 0 ? `${7}/7 passed` : `${failures} failed`}`);
process.exit(failures === 0 ? 0 : 1);
