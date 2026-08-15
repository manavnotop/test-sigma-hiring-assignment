import neo4j, { type Driver, type Session } from "neo4j-driver";
import { getConfig } from "../config.js";

let driver: Driver | null = null;

export function getDriver(): Driver {
  if (driver) return driver;
  const cfg = getConfig();
  driver = neo4j.driver(
    cfg.neo4jUri,
    neo4j.auth.basic(cfg.neo4jUsername, cfg.neo4jPassword),
    { maxConnectionLifetime: 60 * 60 * 1000 }
  );
  return driver;
}

export async function withSession<T>(
  fn: (session: Session) => Promise<T>
): Promise<T> {
  const session = getDriver().session({ database: getConfig().neo4jDatabase });
  try {
    return await fn(session);
  } finally {
    await session.close();
  }
}

export async function verifyGraph(): Promise<boolean> {
  try {
    await getDriver().verifyConnectivity();
    return true;
  } catch {
    return false;
  }
}

export async function closeDriver(): Promise<void> {
  if (driver) {
    await driver.close();
    driver = null;
  }
}

export async function resetRepo(fullName: string): Promise<void> {
  await withSession(async (s) => {
    await s.run(
      `MATCH (n) WHERE n.full_name = $repo DETACH DELETE n`,
      { repo: fullName }
    );
  });
}

export function repoKey(fullName: string): string {
  return fullName;
}

export function fileKey(fullName: string, path: string): string {
  return `${fullName}:${path}`;
}

export function symbolKey(fullName: string, path: string, name: string): string {
  return `${fileKey(fullName, path)}::${name}`;
}

export function screenKey(fullName: string, screenId: string): string {
  return `${fullName}::screen::${screenId}`;
}

export function reqKey(fullName: string, reqId: string): string {
  return `${fullName}::req::${reqId}`;
}
