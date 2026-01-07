#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const ENV_PATH = path.join(REPO_ROOT, ".env");
const TARGET_PATH = path.join(REPO_ROOT, "web", "uk_air_bristol.html");

const envText = await readFileIfExists(ENV_PATH);
if (envText) {
  loadEnvFromText(envText);
}

const projectRef = (process.env.SUPABASE_PROJECT_REF || "").trim();
if (!projectRef) {
  console.error("SUPABASE_PROJECT_REF is missing. Set it in .env or the environment.");
  process.exit(1);
}

const html = await fs.readFile(TARGET_PATH, "utf8");
const refPattern = /const PROJECT_REF_PLACEHOLDER = "([^"]*)";/;
const match = html.match(refPattern);
if (!match) {
  console.error("Could not find PROJECT_REF_PLACEHOLDER in web/uk_air_bristol.html");
  process.exit(1);
}

const updated = html.replace(refPattern, `const PROJECT_REF_PLACEHOLDER = "${projectRef}";`);
if (updated !== html) {
  await fs.writeFile(TARGET_PATH, updated);
  console.log(`Injected SUPABASE_PROJECT_REF=${projectRef} into web/uk_air_bristol.html`);
} else {
  console.log(`web/uk_air_bristol.html already uses SUPABASE_PROJECT_REF=${projectRef}`);
}

function loadEnvFromText(text) {
  text.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      return;
    }
    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) {
      return;
    }
    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();
    if (!key) {
      return;
    }
    if ((value.startsWith("\"") && value.endsWith("\""))
      || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!Object.prototype.hasOwnProperty.call(process.env, key)) {
      process.env[key] = value;
    }
  });
}

async function readFileIfExists(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}
