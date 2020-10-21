export type EntryDeps = { [name: string]: Entry }


export interface Entry {
  version: string;
  integrity?: string;
  resolved?: string;
  requires?: { [name: string]: string };
  dependencies?: EntryDeps;
  dev?: boolean;
  optional?: boolean;
}


export interface BuildContext {
  isYarn: boolean;
  startDir: string;
  rootDeps: EntryDeps;
  visited: Set<string>;
  moduleDirs: Map<string, Entry | null>;
  resolves: Map<Entry, Map<string, Entry>>;
}
