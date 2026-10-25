// Fails when the docs drift from the code: a CLI flag missing from docs/cli.md,
// or a README dependency list that does not match package.json.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const NUMBER_WORDS = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
];

/** Flags named in the help text of src/cli/cli-options.ts. */
export function cliFlags(optionsSource) {
  return [...new Set(optionsSource.match(/--[a-z][a-z-]*/g) ?? [])].filter(
    (f) => f !== "--help",
  );
}

export function missingFlags(flags, cliDoc) {
  return flags.filter(
    (flag) => !cliDoc.includes(`\`${flag}`) && !cliDoc.includes(`[${flag}`),
  );
}

/** Problems in the README sentence "currently has <n> direct runtime dependencies: `a`, `b`...". */
export function readmeDependencyProblems(readme, dependencyNames) {
  const flat = readme.replace(/\s+/g, " ");
  const match = /currently has (\w+) direct runtime dependencies:(.*?)\. /.exec(
    flat,
  );
  if (!match)
    return [
      "README has no 'currently has <n> direct runtime dependencies' sentence",
    ];
  const problems = [];
  if (NUMBER_WORDS.indexOf(match[1]) !== dependencyNames.length) {
    problems.push(
      `README says ${match[1]} dependencies, package.json has ${String(dependencyNames.length)}`,
    );
  }
  for (const name of dependencyNames) {
    if (!match[2].includes(`\`${name}\``))
      problems.push(`README dependency list omits ${name}`);
  }
  return problems;
}

function main() {
  const flags = cliFlags(readFileSync("src/cli/cli-options.ts", "utf8"));
  const names = Object.keys(
    JSON.parse(readFileSync("package.json", "utf8")).dependencies ?? {},
  );
  const problems = [
    ...missingFlags(flags, readFileSync("docs/cli.md", "utf8")).map(
      (f) => `docs/cli.md does not mention ${f}`,
    ),
    ...readmeDependencyProblems(readFileSync("README.md", "utf8"), names),
  ];
  if (problems.length > 0) {
    console.error(`Docs drift:\n${problems.map((p) => `- ${p}`).join("\n")}`);
    process.exit(1);
  }
  console.log(
    `Docs match the code (${String(flags.length)} flags, ${String(names.length)} dependencies).`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
