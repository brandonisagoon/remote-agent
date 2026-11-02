import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, realpath, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { prepareGeneratedCaches, assertGeneratedCaches } from "./generated-cache-capture.ts";
import { finalizationInventory } from "./finalization-resources.ts";
import { prepareInstalledDependencies } from "./installed-dependencies.ts";
const cleanup: string[] = [];
afterEach(async()=>{ for(const root of cleanup.splice(0)) await rm(root,{recursive:true,force:true}); });
async function fixture() {
 const parent=await realpath(await mkdtemp(path.join(os.tmpdir(),"capture-generated-")));cleanup.push(parent);
 const root=path.join(parent,"source"),cache=path.join(root,"apps","app","node_modules"),file=path.join(cache,".vite","metadata.json");
 await mkdir(path.dirname(file),{recursive:true});await writeFile(file,'{"cache":1}');await chmod(cache,0o777);
 await writeFile(path.join(root,"apps/app/package.json"),'{}');await writeFile(path.join(root,"bun.lock"),'lock');await writeFile(path.join(root,".gitignore"),'node_modules\n');
 const git=(...args:string[])=>{const p=Bun.spawnSync(["git",...args],{cwd:root,stdout:"pipe",stderr:"pipe"});if(p.exitCode)throw Error(p.stderr.toString());};
 git("init","-q");git("add",".gitignore","apps/app/package.json","bun.lock");
 const roots=await prepareGeneratedCaches(root,[cache],[cache]);
 const target={type:"tree" as const,path:root,sourcePaths:[root],inventory:await finalizationInventory(root,[root],new Map(),new Map()),quarantine:{directory:path.join(parent,"private"),path:path.join(parent,"private/contents"),journal:path.join(parent,"private/pending.json")}};
 const data={ownerSha256:"a".repeat(64),roots};return{parent,root,cache,file,target,data};
}
test("fully inventoried cache survives a private whole-source capture with original bytes, inode and modes",async()=>{
 const f=await fixture();expect(await prepareInstalledDependencies(f.root,[f.cache])).toEqual([]);
 await assertGeneratedCaches(f.target,f.data,f.root);await mkdir(f.target.quarantine.directory,{mode:0o700});await rename(f.root,f.target.quarantine.path);
 await assertGeneratedCaches(f.target,f.data,f.target.quarantine.path);expect(f.data.roots[0]!.entries[0]!.mode&0o777).toBe(0o777);
});
test("writable caches still fail ordinary installed-dependency preparation",async()=>{const f=await fixture();await expect(prepareInstalledDependencies(f.root)).rejects.toThrow("shared");});
test("renewal rejects changed bytes with identical source root and package pins",async()=>{const f=await fixture();await writeFile(f.file,'{"cache":2}');await expect(assertGeneratedCaches(f.target,f.data,f.root)).rejects.toThrow("changed");});
test("renewal rejects an opaque ancestor hiding the fully inventoried cache",async()=>{const f=await fixture();f.target.inventory.unshift({path:"apps",kind:"opaque",dev:1,ino:1,mode:0o40755,dependencyResourceId:"other"});await expect(assertGeneratedCaches(f.target,f.data,f.root)).rejects.toThrow("opaque");});
test("requires explicit owner selection and tracked package/lock pins",async()=>{const f=await fixture();await expect(prepareGeneratedCaches(f.root,[f.cache],[f.root])).rejects.toThrow("explicit");await writeFile(path.join(f.root,"bun.lock"),'changed');await expect(assertGeneratedCaches(f.target,f.data,f.root)).rejects.toThrow("pin changed");});
