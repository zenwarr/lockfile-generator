import * as path from "path";
import * as fs from "fs";
import {ManifestReader} from "./ManifestReader";
import {BuildContext, Entry, EntryDeps} from "./Interfaces";
import {walkEntries, walkNonSubsetDeps} from "./Walkers";
import {readFileFromHeadOrNow} from "./GitUtils";
import {transformInto} from "./TransformObject";


let manifestReader = new ManifestReader();


/**
 * Returns directory where package is located when required from directory `fromDir`
 * @param fromDir Directory from where to resolve the package
 * @param packageName Package name
 */
function resolvePackageLocation(fromDir: string, packageName: string): string {
  return path.dirname(require.resolve(packageName + "/package.json", {
    paths: [fromDir]
  }));
}


/**
 * Checks if package is available from given directory
 */
function isInstalled(dir: string, packageName: string): boolean {
  try {
    resolvePackageLocation(dir, packageName);
    return true;
  } catch (error) {
    if (error.code === "MODULE_NOT_FOUND") {
      return false;
    }
    throw error;
  }
}


/**
 * Returns map of dependencies of a package located at given directory.
 * Only returns installed packages.
 * For example, if an optional dependency is not installed, it is not going to be returned.
 * Result is compatible with package-lock `requires` field format.
 */
function getRequires(dir: string, includeDev: boolean = false) {
  let manifest = manifestReader.read(dir);

  let requires = {
    ...manifest.dependencies,
    ...manifest.optionalDependencies,
    ...(includeDev ? manifest.devDependencies : null)
  };

  for (let packageName of Object.keys(requires)) {
    if (!isInstalled(dir, packageName)) {
      delete requires[packageName];
    }
  }

  return requires;
}


/**
 * Given a path, returns a path to the closest parent `node_modules` directory, if exists.
 */
function getModulesDir(location: string): string | undefined {
  let root = path.parse(location).root;

  while (true) {
    if (path.basename(location) === "node_modules") {
      return location;
    } else if (location === root) {
      return undefined;
    }

    location = path.dirname(location);
  }
}


/**
 * Given location of `node_modules` directory a package is located in, returns `dependencies` object where the entry for this package should be added.
 */
function getDependencyTarget(ctx: BuildContext, modulesDir: string): EntryDeps {
  modulesDir = path.dirname(modulesDir);

  let target = ctx.moduleDirs.get(modulesDir);
  if (!target) {
    return ctx.rootDeps;
  } else if (!target.dependencies) {
    target.dependencies = {};
  }

  return target.dependencies;
}


/**
 * Creates lockfile entry for a package located inside given directory.
 * If `includeDev` is true, `devDependencies` are also included.
 * When generating lockfile, only devDependencies of the root package should be taken into account.
 */
function buildLockfileEntry(ctx: BuildContext, dir: string, includeDev: boolean): Entry {
  let manifest = manifestReader.read(dir);

  let requires = getRequires(dir, includeDev);

  let entry: Entry = {
    version: manifest.version,
    integrity: manifest._integrity,
    resolved: manifest._resolved,
    requires: requires,
    dependencies: {}
  };

  ctx.visited.add(dir);
  ctx.moduleDirs.set(dir, entry);

  let entryResolves = new Map<string, Entry>();
  ctx.resolves.set(entry, entryResolves);

  for (let depName of Object.keys(requires)) {
    let resolvedDir = resolvePackageLocation(dir, depName);
    if (ctx.visited.has(resolvedDir)) {
      continue;
    }

    let depsObject: EntryDeps;

    let modulesDir = getModulesDir(resolvedDir);
    if (!modulesDir) {
      depsObject = ctx.rootDeps;
    } else {
      depsObject = getDependencyTarget(ctx, modulesDir);
    }

    if (!(depName in depsObject)) {
      let depEntry = buildLockfileEntry(ctx, resolvedDir, false);
      depsObject[depName] = depEntry;
      entryResolves.set(depName, depEntry);
    } else {
      let depEntry = depsObject[depName];
      entryResolves.set(depName, depEntry);
    }
  }

  return entry;
}


/**
 * Generates lockfile for a package located at given directory
 */
function generateLockfile(dir: string, packagesDir: string): object | undefined {
  let ctx: BuildContext = {
    packagesDir,
    startDir: dir,
    rootDeps: {},
    visited: new Set(),
    moduleDirs: new Map(),
    resolves: new Map(),
  };

  let manifest = manifestReader.readIfExists(dir);
  if (!manifest) {
    return undefined;
  }

  let entry = buildLockfileEntry(ctx, dir, true);
  ctx.rootDeps = {
    ...entry.dependencies,
    ...ctx.rootDeps
  };

  walkEntries(ctx.rootDeps, dep => {
    if (dep.dependencies && !Object.keys(dep.dependencies).length) {
      delete dep.dependencies;
    }

    if (dep.requires && !Object.keys(dep.requires).length) {
      delete dep.requires;
    }
  });

  markDevDeps(ctx);
  markOptionalDeps(ctx);

  return {
    name: manifest.name,
    version: manifest.version,
    lockfileVersion: 1,
    requires: true,
    dependencies: ctx.rootDeps
  };
}


async function saveLockfile(dir: string, lockfile: any) {
  let lockfileLocation = path.join(dir, "package-lock.json");
  let originalContents = await readFileFromHeadOrNow(lockfileLocation);

  let original = {};
  try {
    original = JSON.parse(originalContents || "");
  } catch (e) {
    // do nothing
  }

  fs.writeFileSync(lockfileLocation, JSON.stringify(transformInto(original, lockfile), undefined, 2), "utf-8");
}


function markDevDeps(ctx: BuildContext) {
  let manifest = manifestReader.read(ctx.startDir);
  let nonDevDeps = {
    ...manifest.dependencies,
    ...manifest.optionalDependencies,
    ...manifest.peerDependencies
  };

  walkNonSubsetDeps(ctx, Object.keys(nonDevDeps), e => {
    e.dev = true;
  });
}


function markOptionalDeps(ctx: BuildContext) {
  let manifest = manifestReader.read(ctx.startDir);
  let nonOptionalDeps = {
    ...manifest.dependencies,
    ...manifest.devDependencies,
    ...manifest.peerDependencies
  };

  walkNonSubsetDeps(ctx, Object.keys(nonOptionalDeps), e => {
    e.optional = true;
  });
}


export async function updateLocks() {
  let dir = process.argv[2] || "packages";
  dir = path.resolve(process.cwd(), dir);
  for (let entryName of fs.readdirSync(dir)) {
    console.log(`Generating lockfile for ${entryName}...`);
    let pkgDir = path.join(dir, entryName);

    let stat = fs.statSync(pkgDir);
    if (!stat.isDirectory()) {
      continue;
    }

    let lockfile = generateLockfile(pkgDir, dir);
    if (lockfile) {
      await saveLockfile(pkgDir, lockfile);
    }
  }

  let topDir = path.dirname(dir);
  console.log(`Generating lockfile for workspace root...`);
  await saveLockfile(topDir, generateLockfile(topDir, dir));
}