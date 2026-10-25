// Fails when the verification skill drifts: a helper missing from SKILL.md,
// a feature file missing from the index, or a CLI flag no feature file mentions.
import { readdirSync, readFileSync } from "node:fs";
import { posix } from "node:path";
import { pathToFileURL } from "node:url";
import { cliFlags } from "./check-docs.mjs";

const SKILL_DIR = ".claude/skills/verify-capdelta";
const FEATURES_DIR = `${SKILL_DIR}/features`;

export function unlistedBinHelpers(binFiles, skillMarkdown) {
  return binFiles.filter((file) => !skillMarkdown.includes(`bin/${file}`));
}

export function featureIndexProblems(featureFiles, indexMarkdown) {
  const linked = new Set();
  const problems = [];
  for (const match of indexMarkdown.matchAll(/\]\(([^)]+)\)/g)) {
    const target = match[1].trim().split("#")[0];
    if (target === "" || /^[a-z][a-z+.-]*:/i.test(target)) continue;
    const normalized = posix.normalize(target);
    if (posix.isAbsolute(normalized) || normalized.startsWith("..")) continue;
    linked.add(normalized);
    if (!featureFiles.includes(normalized)) {
      problems.push(`features/README.md links to missing ${normalized}`);
    }
  }
  for (const file of featureFiles) {
    if (!linked.has(file)) {
      problems.push(`features/README.md does not link ${file}`);
    }
  }
  return problems;
}

export function flagsMissingFromFeatures(flags, featureTexts) {
  // Whole-flag matching so --base does not satisfy --base-url.
  return flags.filter(
    (flag) =>
      !featureTexts.some((text) => new RegExp(`${flag}(?![\\w-])`).test(text)),
  );
}

function main() {
  const skillMarkdown = readFileSync(`${SKILL_DIR}/SKILL.md`, "utf8");
  const binFiles = readdirSync(`${SKILL_DIR}/bin`).sort();
  const featureFiles = readdirSync(FEATURES_DIR)
    .filter((file) => file.endsWith(".md") && file !== "README.md")
    .sort();
  const featureTexts = readdirSync(FEATURES_DIR)
    .filter((file) => file.endsWith(".md"))
    .map((file) => readFileSync(`${FEATURES_DIR}/${file}`, "utf8"));
  const flags = cliFlags(readFileSync("src/cli/cli-options.ts", "utf8"));

  const problems = [
    ...unlistedBinHelpers(binFiles, skillMarkdown).map(
      (file) => `SKILL.md does not name bin/${file}`,
    ),
    ...featureIndexProblems(
      featureFiles,
      readFileSync(`${FEATURES_DIR}/README.md`, "utf8"),
    ),
    ...flagsMissingFromFeatures(flags, featureTexts).map(
      (flag) => `no file under features/ mentions ${flag}`,
    ),
  ];
  if (problems.length > 0) {
    console.error(
      `Skill drift:\n${problems.map((problem) => `- ${problem}`).join("\n")}`,
    );
    process.exit(1);
  }
  console.log(
    `Skill matches the CLI (${String(binFiles.length)} helpers, ` +
      `${String(featureFiles.length)} feature files, ${String(flags.length)} flags).`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
