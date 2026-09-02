import { describe, expect, it } from "vitest";
import { L1SessionCache, TieredContextCache, type PersistentContextCache } from "../src/index";

class L2Fake implements PersistentContextCache {
  values=new Map<string,{value:unknown,deps:string[],stale:boolean}>();
  hashes=new Map<string,string>();
  async get(key:string){ return this.values.get(key); }
  async checkFresh(key:string){ const v=this.values.get(key); return Boolean(v&&!v.stale); }
  async set(key:string,value:unknown,deps:string[]){ this.values.set(key,{value,deps,stale:false}); }
  async delete(key:string){ return this.values.delete(key); }
  async invalidate(hash:string){ let n=0;for(const [k,v] of this.values){if(v.deps.includes(hash)){this.values.delete(k);n++;}}return n; }
  async updateHash(oldHash:string,newHash:string){ this.hashes.set(oldHash,newHash); }
  async recordFileHash(path:string,hash:string){ this.hashes.set(path,hash); }
  async getFileHash(path:string){ return this.hashes.get(path); }
}

describe("TieredContextCache",()=>{
  it("promotes L2 hits to L1",async()=>{
    const l1=new L1SessionCache(60_000),l2=new L2Fake();
    await l2.set("k",{v:1},[]);
    const cache=new TieredContextCache(l1,l2);
    expect((await cache.get<{v:number}>("k"))?.tier).toBe("l2");
    l2.values.clear();
    expect((await cache.get<{v:number}>("k"))?.tier).toBe("l1");
  });

  it("does not seed L1 when the persistent L2 write fails",async()=>{
    const l1=new L1SessionCache(60_000);
    const l2=new L2Fake();
    l2.set=async()=>{ throw new Error("redis-unavailable"); };
    const cache=new TieredContextCache(l1,l2);

    await expect(cache.set("k",{v:1},[])).rejects.toThrow("redis-unavailable");
    expect(l1.get("k")).toBeUndefined();
  });
});
