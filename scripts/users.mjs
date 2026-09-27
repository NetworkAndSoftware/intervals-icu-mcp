// Manages who can sign in to the Lambda-hosted server. Users and the token-signing secret are
// SecureString parameters in SSM Parameter Store, in the region of your default AWS profile
// (the one `sam deploy` uses). Lambda reads them once per cold start, so every change here
// also recycles the function's running instances.
import "dotenv/config";
import { randomBytes, randomInt } from "node:crypto";
import { createInterface } from "node:readline";
import { GetParameterCommand, ParameterNotFound, PutParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { LambdaClient, ResourceNotFoundException, UpdateFunctionConfigurationCommand } from "@aws-sdk/client-lambda";

const USAGE = `Usage: npm run users -- <command>

  list                   Show users and their athlete IDs
  add <name>             Add a user, or update an existing user's intervals.icu credentials.
                         Prompts for athlete ID and API key; --from-env takes them from .env.
                         A new user gets a generated password; --new-password replaces an existing one.
  new-password <name>    Replace a user's password (signs them out everywhere)
  show-password <name>   Print a user's password
  remove <name>          Remove a user (signs them out everywhere)
  sign-out-all           Replace the signing secret (signs everyone out)`;

const prefix = process.env.SSM_PREFIX ?? "/intervals-icu-mcp";
const functionName = "intervals-icu-mcp"; // FunctionName in template.yaml
const ssm = new SSMClient({});

const args = process.argv.slice(2);
const flags = new Set(args.filter((arg) => arg.startsWith("--")));
const [command, rawName] = args.filter((arg) => !arg.startsWith("--"));
const name = rawName?.toLowerCase();

function fail(message) {
  console.error(message);
  process.exit(1);
}

async function getParameter(parameter) {
  try {
    const result = await ssm.send(new GetParameterCommand({ Name: `${prefix}/${parameter}`, WithDecryption: true }));
    return result.Parameter.Value;
  } catch (error) {
    if (error instanceof ParameterNotFound) return undefined;
    throw error;
  }
}

async function putParameter(parameter, value) {
  await ssm.send(new PutParameterCommand({ Name: `${prefix}/${parameter}`, Value: value, Type: "SecureString", Overwrite: true }));
}

async function loadUsers() {
  return JSON.parse((await getParameter("USERS")) ?? "[]");
}

async function saveUsers(users) {
  if (!(await getParameter("MCP_SIGNING_SECRET"))) await putParameter("MCP_SIGNING_SECRET", newSigningSecret());
  await putParameter("USERS", JSON.stringify(users));
}

function findUser(users) {
  const user = users.find((u) => u.name === name);
  if (!user) fail(`No user named ${name}. Existing users: ${users.map((u) => u.name).join(", ") || "none"}`);
  return user;
}

// Lowercase letters only, to be easy to type on a phone: 24 letters is ~113 bits
function newPassword() {
  const letters = Array.from({ length: 24 }, () => String.fromCharCode(97 + randomInt(26))).join("");
  return letters.match(/.{4}/g).join("-");
}

function newSigningSecret() {
  return randomBytes(32).toString("hex");
}

// Any configuration change makes Lambda start fresh instances, which read the new values
async function recycleLambda() {
  try {
    await new LambdaClient({}).send(
      new UpdateFunctionConfigurationCommand({ FunctionName: functionName, Description: `Secrets updated ${new Date().toISOString()}` })
    );
    console.log(`Recycled ${functionName} so it picks up the change.`);
  } catch (error) {
    if (!(error instanceof ResourceNotFoundException)) throw error;
    console.log(`${functionName} isn't deployed yet; run npm run deploy next.`);
  }
}

let readline, lines;
async function ask(question, { hidden = false } = {}) {
  if (!readline) {
    readline = createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) });
    lines = readline[Symbol.asyncIterator]();
  }
  readline.setPrompt(question);
  readline.prompt();
  const echo = readline._writeToOutput;
  // Don't echo what's typed (the API key)
  if (hidden && process.stdin.isTTY) readline._writeToOutput = () => {};
  const { value = "" } = await lines.next();
  if (readline._writeToOutput !== echo) {
    readline._writeToOutput = echo;
    process.stdout.write("\n");
  }
  return value.trim();
}

async function checkCredentials(athleteId, apiKey) {
  const res = await fetch(`https://intervals.icu/api/v1/athlete/${athleteId}`, {
    headers: { Authorization: `Basic ${Buffer.from(`API_KEY:${apiKey}`).toString("base64")}` },
  });
  if (res.ok) return;
  const reasons = {
    401: "the API key was rejected",
    403: "the API key doesn't belong to that athlete ID",
    404: "there's no athlete with that ID",
  };
  fail(`intervals.icu didn't accept these credentials: ${reasons[res.status] ?? `HTTP ${res.status}`}`);
}

function printPassword(user) {
  console.log(`\nPassword for ${user.name}:\n\n  ${user.password}\n`);
}

if (!command || (command !== "list" && command !== "sign-out-all" && !name)) {
  console.log(USAGE);
  process.exit(command ? 1 : 0);
}
if (name && !/^[a-z0-9_-]+$/.test(name)) fail("Names may only use letters, digits, - and _");

console.log(`Region: ${await ssm.config.region()}`);

switch (command) {
  case "list": {
    const users = await loadUsers();
    for (const user of users) console.log(`${user.name}\t${user.athleteId}`);
    if (users.length === 0) console.log("No users yet. Add one with: npm run users -- add <name>");
    break;
  }

  case "add": {
    let athleteId, apiKey;
    if (flags.has("--from-env")) {
      ({ INTERVALS_ATHLETE_ID: athleteId, INTERVALS_API_KEY: apiKey } = process.env);
      if (!athleteId || !apiKey) fail("INTERVALS_ATHLETE_ID and INTERVALS_API_KEY must be set in .env");
    } else {
      athleteId = await ask("intervals.icu athlete ID (Settings page, e.g. i12345): ");
      apiKey = await ask("intervals.icu API key (Settings > Developer Settings): ", { hidden: true });
    }
    if (/^\d+$/.test(athleteId)) athleteId = `i${athleteId}`;
    if (!/^i\d+$/.test(athleteId)) fail(`That doesn't look like an athlete ID: ${athleteId}`);
    await checkCredentials(athleteId, apiKey);

    const users = await loadUsers();
    let user = users.find((u) => u.name === name);
    const showPassword = !user || flags.has("--new-password");
    if (user) {
      Object.assign(user, { athleteId, apiKey });
      if (flags.has("--new-password")) user.password = newPassword();
    } else {
      user = { name, password: newPassword(), athleteId, apiKey };
      users.push(user);
    }
    await saveUsers(users);
    console.log(`Saved ${name} (${athleteId}).`);
    await recycleLambda();
    if (showPassword) printPassword(user);
    break;
  }

  case "new-password": {
    const users = await loadUsers();
    const user = findUser(users);
    user.password = newPassword();
    await saveUsers(users);
    await recycleLambda();
    printPassword(user);
    break;
  }

  case "show-password": {
    printPassword(findUser(await loadUsers()));
    break;
  }

  case "remove": {
    const users = await loadUsers();
    findUser(users);
    const remaining = users.filter((u) => u.name !== name);
    if (remaining.length === 0) fail("Can't remove the last user; the server needs at least one.");
    await saveUsers(remaining);
    console.log(`Removed ${name}.`);
    await recycleLambda();
    break;
  }

  case "sign-out-all": {
    await putParameter("MCP_SIGNING_SECRET", newSigningSecret());
    console.log("Replaced the signing secret.");
    await recycleLambda();
    break;
  }

  default:
    console.log(USAGE);
    process.exitCode = 1;
}

readline?.close();
